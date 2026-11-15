import { useEffect, useState } from "react";
import clsx from "clsx";
import {
  ArrowUpRight,
  SidebarSimple,
  Swatches as SwatchesIcon,
} from "@phosphor-icons/react";
import type { SwatchLink, SwatchTrace } from "@shared/swatches";
import { api, useEvent } from "@/lib/api";
import { isMobile } from "@/lib/platform";
import { openSwatch, openSwatchInPanel, useSwatchNav } from "@/lib/swatchNav";
import { Tooltip } from "./Tooltip";

const KIND: Record<SwatchTrace["format"], string> = {
  html: "Page",
  markdown: "Document",
  svg: "Image",
};

/**
 * A swatch the agent published, shown in the conversation as itself: a live preview of the page, with its name
 * and buttons to show it in the side panel or open it on the Swatches page.
 */
export function SwatchBlock({ swatch }: { swatch: SwatchTrace }) {
  const showing = useSwatchNav((s) => s.panelVisible && s.panel === swatch.id);
  // undefined while loading; null once it's gone (deleted).
  const [links, setLinks] = useState<SwatchLink[] | null | undefined>(
    undefined,
  );
  const [version, setVersion] = useState(0);
  const load = () =>
    void api.swatches.links(swatch.id).then(setLinks, () => setLinks(null));
  useEffect(load, [swatch.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // A new version (or a new link) shows here too.
  useEvent("swatches", (e) => {
    if (e.type === "status" || e.id === swatch.id) {
      setVersion((n) => n + 1);
      load();
    }
  });
  // A phone can't reach this PC's 127.0.0.1: it previews through a network link.
  const preview = links
    ? isMobile
      ? links.find((l) => l.kind !== "local")
      : links.find((l) => l.kind === "local")
    : undefined;
  const gone = links === null;

  return (
    <div
      className={clsx(
        "my-2 w-full max-w-[640px] overflow-hidden rounded-xl border transition-colors",
        showing ? "border-crimson" : "border-line",
      )}
    >
      {!gone && (
        <div className="h-[300px] bg-white mobile:h-[240px]">
          {preview ? (
            <iframe
              key={`${preview.url}:${version}`}
              src={preview.url}
              title={swatch.title}
              loading="lazy"
              sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
              className="h-full w-full border-0"
            />
          ) : (
            <div className="grid h-full place-items-center p-6 text-center text-caption text-dim">
              {links && isMobile
                ? "Turn on “Share on your network” on the computer running Cloth to see swatches here."
                : "Loading…"}
            </div>
          )}
        </div>
      )}
      <div
        className={clsx(
          "flex items-center gap-2.5 px-3 py-2",
          !gone && "border-t",
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
