import { useEffect, useState } from "react";
import clsx from "clsx";
import {
  ArrowUpRight,
  SidebarSimple,
  SquaresFour,
  Swatches as SwatchesIcon,
} from "@phosphor-icons/react";
import type { SwatchLink, SwatchTrace } from "@shared/swatches";
import { api, useEvent } from "@/lib/api";
import { openSwatch, openSwatchInPanel, useSwatchNav } from "@/lib/swatchNav";
import { Tooltip } from "./Tooltip";
import { useThumbs } from "./MockupCanvas";

const KIND: Record<SwatchTrace["format"], string> = {
  html: "Page",
  markdown: "Document",
  svg: "Image",
  mockup: "Mockup",
};

/**
 * A swatch the agent published, shown in the conversation by its name and kind, with buttons to show it in the
 * side panel or open it on the Swatches page. The page itself shows there, not in the chat.
 */
export function SwatchBlock({ swatch }: { swatch: SwatchTrace }) {
  if (swatch.format === "mockup") return <MockupCard swatch={swatch} />;
  return <PageBlock swatch={swatch} />;
}

function PageBlock({ swatch }: { swatch: SwatchTrace }) {
  const showing = useSwatchNav((s) => s.panelVisible && s.panel === swatch.id);
  // undefined while loading; null once it's gone (deleted).
  const [links, setLinks] = useState<SwatchLink[] | null | undefined>(
    undefined,
  );
  const load = () =>
    void api.swatches.links(swatch.id).then(setLinks, () => setLinks(null));
  useEffect(load, [swatch.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Deleted (or brought back) since: the bar says so.
  useEvent("swatches", (e) => {
    if (e.type === "changed" && e.id === swatch.id) load();
  });
  const gone = links === null;

  return (
    <div
      className={clsx(
        "my-2 w-full max-w-[480px] overflow-hidden rounded-xl border transition-colors",
        showing ? "border-crimson" : "border-line",
      )}
    >
      <div
        className={clsx(
          "flex items-center gap-2.5 px-3 py-2",
          showing
            ? "border-crimson-line bg-crimson-soft/60"
            : "border-line bg-elev",
        )}
      >
        <SwatchesIcon
          size={16}
          className="shrink-0 text-crimson-text"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-ui font-medium text-fg">
            {swatch.title}
          </div>
          <div className="truncate text-micro text-dim">
            {gone
              ? "Deleted"
              : `${KIND[swatch.format]} swatch${swatch.version > 1 ? ` · version ${swatch.version}` : ""}`}
          </div>
        </div>
        {!gone && (
          <>
            <button
              type="button"
              onClick={() => openSwatchInPanel(swatch.id)}
              aria-label={`Show ${swatch.title} in the side panel`}
              className={clsx(
                "flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-caption font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-crimson-hi",
                showing
                  ? "border border-crimson-line text-crimson-text"
                  : "bg-crimson text-white hover:bg-crimson-hi",
              )}
            >
              <SidebarSimple size={13} mirrored aria-hidden="true" />
              {showing ? "Showing" : "Open"}
            </button>
            <Tooltip content="Open on the Swatches page">
              <button
                type="button"
                onClick={() => openSwatch(swatch.id)}
                aria-label={`Open ${swatch.title} on the Swatches page`}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-line-strong text-muted hover:bg-elev-2 hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-crimson-hi"
              >
                <ArrowUpRight size={13} />
              </button>
            </Tooltip>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * A mockup the agent published: its boards as thumbnails (made in the background), and buttons to open its canvas
 * in the side panel or on the Swatches page. A card from an earlier version shows that version's boards.
 */
function MockupCard({ swatch }: { swatch: SwatchTrace }) {
  const showing = useSwatchNav((s) => s.panelVisible && s.panel === swatch.id);
  const thumbs = useThumbs(swatch.id, swatch.version);
  const [gone, setGone] = useState(false);
  const check = () =>
    void api.swatches.links(swatch.id).then(
      () => setGone(false),
      () => setGone(true),
    );
  useEffect(check, [swatch.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEvent("swatches", (e) => {
    if (e.type === "changed" && e.id === swatch.id) check();
  });
  const boards = swatch.boards ?? [];
  const shown = boards.slice(0, 8);

  return (
    <div
      className={clsx(
        "my-2 w-full max-w-[760px] overflow-hidden rounded-xl border bg-elev transition-colors",
        showing ? "border-crimson" : "border-line",
      )}
    >
      <div className="flex items-center gap-2.5 border-b border-line px-3 py-2">
        <SquaresFour size={16} className="shrink-0 text-crimson-text" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-ui font-medium text-fg">{swatch.title}</div>
          <div className="truncate text-micro text-dim">
            {gone
              ? "Deleted"
              : `Mockup · ${boards.length} board${boards.length === 1 ? "" : "s"}${swatch.version > 1 ? ` · version ${swatch.version}` : ""}`}
          </div>
        </div>
        {!gone && (
          <>
            <button
              type="button"
              onClick={() => openSwatchInPanel(swatch.id)}
              aria-label={`Show ${swatch.title} in the side panel`}
              className={clsx(
                "flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-caption font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-crimson-hi",
                showing
                  ? "border border-crimson-line text-crimson-text"
                  : "bg-crimson text-white hover:bg-crimson-hi",
              )}
            >
              <SidebarSimple size={13} mirrored aria-hidden="true" />
              {showing ? "Showing" : "Open"}
            </button>
            <Tooltip content="Open the canvas on the Swatches page">
              <button
                type="button"
                onClick={() => openSwatch(swatch.id)}
                aria-label={`Open ${swatch.title} on the Swatches page`}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-line-strong text-muted hover:bg-elev-2 hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-crimson-hi"
              >
                <ArrowUpRight size={13} />
              </button>
            </Tooltip>
          </>
        )}
      </div>
      {!gone && shown.length > 0 && (
        <div className="grid grid-cols-4 gap-2.5 p-3 mobile:grid-cols-2">
          {shown.map((b) => {
            const src = thumbs?.[b.name];
            return (
              <button
                key={b.name}
                type="button"
                onClick={() => openSwatch(swatch.id)}
                className="group flex min-w-0 flex-col gap-1.5 text-left"
                aria-label={`${b.title}: open the canvas`}
              >
                <span className="flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-md border border-line bg-bg group-hover:border-line-strong">
                  {src ? (
                    <img src={src} alt="" className="h-full w-full object-cover object-top" />
                  ) : (
                    <span className="h-2 w-10 animate-pulse rounded bg-elev-2" aria-hidden="true" />
                  )}
                </span>
                <span className="truncate text-caption text-muted group-hover:text-fg">{b.title}</span>
              </button>
            );
          })}
        </div>
      )}
      {!gone && boards.length > shown.length && (
        <div className="px-3 pb-2.5 text-caption text-dim">
          and {boards.length - shown.length} more on the canvas
        </div>
      )}
    </div>
  );
}
