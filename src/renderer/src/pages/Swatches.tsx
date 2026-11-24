import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import QRCode from "qrcode";
import {
  ArrowLeft,
  ArrowSquareOut,
  CaretRight,
  ChatCircleDots,
  Copy,
  DotsThree,
  DownloadSimple,
  FileHtml,
  FileText,
  ImageSquare,
  LinkSimple,
  MagnifyingGlass,
  PencilSimple,
  SquaresFour,
  Swatches as SwatchesIcon,
  Trash,
  WarningCircle,
  WifiHigh,
  WifiSlash,
  type Icon,
} from "@phosphor-icons/react";
import type { Swatch, SwatchLink, SwatchServerStatus } from "@shared/swatches";
import { api, useEvent } from "@/lib/api";
import { attempt, useApp } from "@/lib/store";
import { bytes as formatBytes, timeAgo } from "@/lib/format";
import { isMobile, useSideBySide } from "@/lib/platform";
import { useSwatchNav } from "@/lib/swatchNav";
import {
  Badge,
  Button,
  IconButton,
  Input,
  Select,
  confirmAction,
} from "@/components/ui";
import { SplitDetail, SplitRoot } from "@/components/SplitView";
import { MockupCanvas } from "@/components/MockupCanvas";
import { openSettingsSection } from "./Settings";

type FilterFormat = "all" | Swatch["format"];
type SortOrder = "updated" | "name" | "created";

type FormatInfo = { label: string; icon: Icon; cover: string };

const FORMAT: Record<Swatch["format"], FormatInfo> = {
  html: {
    label: "Page",
    icon: FileHtml,
    cover: "from-panel via-elev to-crimson/15",
  },
  markdown: { label: "Document", icon: FileText, cover: "from-elev to-panel" },
  svg: {
    label: "Image",
    icon: ImageSquare,
    cover: "from-[#25262c] via-[#35323a] to-[#292a30]",
  },
  mockup: {
    label: "Mockup",
    icon: SquaresFour,
    cover: "from-elev via-panel to-crimson/10",
  },
};

const FORMAT_FILTERS: { value: FilterFormat; label: string }[] = [
  { value: "all", label: "All" },
  { value: "html", label: "Pages" },
  { value: "markdown", label: "Documents" },
  { value: "svg", label: "Images" },
  { value: "mockup", label: "Mockups" },
];

const CHART_BARS = [34, 55, 43, 76, 58, 88, 67, 96, 73, 82];
const IMAGE_SWATCHES = [
  "bg-series-1",
  "bg-series-2",
  "bg-series-3",
  "bg-series-4",
  "bg-elev-2",
];

/** Swatches: pages chats publish, previewed here and shared by private link. */
export function SwatchesPage() {
  const [items, setItems] = useState<Swatch[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<SwatchServerStatus | null>(null);
  const [network, setNetwork] = useState(false);
  const [networkBusy, setNetworkBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [formatFilter, setFormatFilter] = useState<FilterFormat>("all");
  const [sortOrder, setSortOrder] = useState<SortOrder>("updated");
  const [open, setOpen] = useState(() => !!useSwatchNav.getState().selected);
  const selected = useSwatchNav((state) => state.selected);
  const side = useSideBySide();

  const load = async () => {
    try {
      const [list, nextStatus, settings] = await Promise.all([
        api.swatches.list(),
        api.swatches.status(),
        api.settings.get(),
      ]);
      setItems(list);
      setStatus(nextStatus);
      setNetwork(settings.swatchNetwork);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEvent("swatches", (event) => {
    if (event.type === "status") {
      setStatus(event.status);
      return;
    }
    void api.swatches
      .list()
      .then(setItems)
      .catch((error: unknown) =>
        setLoadError(error instanceof Error ? error.message : String(error)),
      );
  });

  const active = items?.find((swatch) => swatch.id === selected);
  const visibleItems = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const collator = new Intl.Collator(undefined, {
      sensitivity: "base",
      numeric: true,
    });
    return [...(items ?? [])]
      .filter(
        (swatch) =>
          (formatFilter === "all" || swatch.format === formatFilter) &&
          (!query || swatch.title.toLocaleLowerCase().includes(query)),
      )
      .sort((a, b) => {
        if (sortOrder === "name") return collator.compare(a.title, b.title);
        if (sortOrder === "created") return b.createdAt - a.createdAt;
        return b.updatedAt - a.updatedAt;
      });
  }, [items, search, formatFilter, sortOrder]);

  const setShared = async (enabled: boolean) => {
    if (networkBusy || enabled === network) return;
    setNetworkBusy(true);
    setNetwork(enabled);
    const updated = await attempt(() =>
      api.settings.update({ swatchNetwork: enabled }),
    );
    if (!updated) setNetwork(!enabled);
    setNetworkBusy(false);
  };

  const openSwatch = (swatch: Swatch) => {
    useSwatchNav.setState({ selected: swatch.id });
    setOpen(true);
  };

  const backToLibrary = () => {
    setOpen(false);
    useSwatchNav.setState({ selected: null });
  };

  const openChat = () => useApp.getState().setPage("chat");
  const compact = isMobile && !side;

  const library = (
    <SwatchLibrary
      items={items}
      visibleItems={visibleItems}
      loadError={loadError}
      status={status}
      network={network}
      networkBusy={networkBusy}
      search={search}
      formatFilter={formatFilter}
      sortOrder={sortOrder}
      compact={compact}
      onSearch={setSearch}
      onFilter={setFormatFilter}
      onSort={setSortOrder}
      onNetworkChange={(enabled) => void setShared(enabled)}
      onOpen={openSwatch}
      onOpenChat={openChat}
      onRetry={() => void load()}
    />
  );

  if (side) {
    if (!open || !active) return library;
    return (
      <SwatchDetail
        swatch={active}
        network={network}
        status={status}
        onBack={backToLibrary}
        onNetworkChange={(enabled) => void setShared(enabled)}
      />
    );
  }

  return (
    <SplitRoot open={open && !!active} onBack={backToLibrary}>
      <div className="h-full min-w-0">{library}</div>
      <SplitDetail>
        {active && (
          <SwatchDetail
            swatch={active}
            network={network}
            status={status}
            onBack={backToLibrary}
            onNetworkChange={(enabled) => void setShared(enabled)}
          />
        )}
      </SplitDetail>
    </SplitRoot>
  );
}

function SwatchLibrary({
  items,
  visibleItems,
  loadError,
  status,
  network,
  networkBusy,
  search,
  formatFilter,
  sortOrder,
  compact,
  onSearch,
  onFilter,
  onSort,
  onNetworkChange,
  onOpen,
  onOpenChat,
  onRetry,
}: {
  items: Swatch[] | null;
  visibleItems: Swatch[];
  loadError: string | null;
  status: SwatchServerStatus | null;
  network: boolean;
  networkBusy: boolean;
  search: string;
  formatFilter: FilterFormat;
  sortOrder: SortOrder;
  compact: boolean;
  onSearch(value: string): void;
  onFilter(value: FilterFormat): void;
  onSort(value: SortOrder): void;
  onNetworkChange(value: boolean): void;
  onOpen(swatch: Swatch): void;
  onOpenChat(): void;
  onRetry(): void;
}) {
  const counts = useMemo(() => {
    const out: Record<FilterFormat, number> = {
      all: items?.length ?? 0,
      html: 0,
      markdown: 0,
      svg: 0,
      mockup: 0,
    };
    for (const swatch of items ?? []) out[swatch.format] += 1;
    return out;
  }, [items]);

  return (
    <main
      className={clsx(
        "flex h-full min-h-0 flex-col bg-bg",
        compact ? "overflow-y-auto" : "overflow-hidden",
      )}
    >
      <div
        className={clsx(
          "shrink-0",
          compact ? "px-4 pb-4 pt-5" : "px-5 pb-5 pt-7 lg:px-8",
        )}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="truncate text-title font-semibold tracking-tight">
              Swatches
            </h1>
          </div>
          {compact ? (
            <IconButton
              aria-label="Ask a chat to make a swatch"
              title="Ask a chat to make a swatch"
              onClick={onOpenChat}
              className="h-10 w-10 border border-line text-muted"
            >
              <ChatCircleDots size={17} />
            </IconButton>
          ) : (
            <Button
              variant="primary"
              icon={<ChatCircleDots size={15} />}
              onClick={onOpenChat}
            >
              Ask a chat to make one
            </Button>
          )}
        </div>

        <ShareBanner
          status={status}
          network={network}
          busy={networkBusy}
          compact={compact}
          onChange={onNetworkChange}
        />
        {status?.error && (
          <div
            className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-danger-line bg-danger-soft px-3 py-2 text-caption text-danger-hi"
            role="alert"
          >
            <WarningCircle size={15} aria-hidden="true" />
            <span className="min-w-0 flex-1">
              {status.error.replace(
                / Pick another in Settings › Swatches\.$/,
                "",
              )}
            </span>
            {!compact && (
              <Button size="sm" onClick={() => openSettingsSection("swatches")}>
                Change the port
              </Button>
            )}
          </div>
        )}

        <div
          className={clsx(
            "mt-4 flex flex-wrap items-center gap-3",
            compact && "mt-4",
          )}
        >
          <div
            className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            role="group"
            aria-label="Filter swatches by format"
          >
            {FORMAT_FILTERS.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                aria-pressed={formatFilter === value}
                onClick={() => onFilter(value)}
                className={clsx(
                  "flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-caption transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crimson-line",
                  formatFilter === value
                    ? "bg-elev-2 font-semibold text-fg"
                    : "text-dim hover:bg-elev hover:text-muted",
                )}
              >
                {label}
                <span
                  className={clsx(
                    "font-mono text-micro tabular-nums",
                    formatFilter === value ? "text-muted" : "text-dim",
                  )}
                >
                  {counts[value]}
                </span>
              </button>
            ))}
          </div>
          <div
            className={clsx(
              "flex min-w-0 items-center gap-2",
              compact && "w-full",
            )}
          >
            <label className="relative min-w-0 flex-1 sm:flex-none">
              <span className="sr-only">Search swatches</span>
              <MagnifyingGlass
                size={14}
                className="pointer-events-none absolute left-2.5 top-2 text-dim"
                aria-hidden="true"
              />
              <Input
                id="swatch-search"
                aria-label="Search swatches"
                placeholder="Search swatches"
                value={search}
                onChange={(event) => onSearch(event.target.value)}
                className="h-8 pl-8 sm:w-52"
              />
            </label>
            {!compact && (
              <Select
                aria-label="Sort swatches"
                value={sortOrder}
                onChange={(event) => onSort(event.target.value as SortOrder)}
                className="w-40"
              >
                <option value="updated">Recently updated</option>
                <option value="name">Name</option>
                <option value="created">Recently created</option>
              </Select>
            )}
          </div>
        </div>
      </div>

      <div
        className={clsx(
          "min-h-0 flex-1",
          compact
            ? "overflow-visible px-4 pb-5"
            : "overflow-y-auto px-5 pb-6 lg:px-8",
        )}
      >
        {loadError && items === null ? (
          <div className="grid min-h-56 place-items-center rounded-xl border border-line bg-panel p-6 text-center">
            <div>
              <WarningCircle
                size={22}
                className="mx-auto mb-3 text-danger-hi"
                aria-hidden="true"
              />
              <p className="text-body font-medium text-fg">
                Could not load swatches
              </p>
              <p className="mt-1 max-w-sm text-caption text-dim">{loadError}</p>
              <Button className="mt-4" onClick={onRetry}>
                Try again
              </Button>
            </div>
          </div>
        ) : items === null ? (
          <SwatchSkeleton compact={compact} />
        ) : items.length === 0 ? (
          <EmptyLibrary compact={compact} onOpenChat={onOpenChat} />
        ) : visibleItems.length === 0 ? (
          <div className="grid min-h-52 place-items-center rounded-xl border border-line bg-panel p-6 text-center">
            <div>
              <MagnifyingGlass
                size={22}
                className="mx-auto mb-3 text-dim"
                aria-hidden="true"
              />
              <p className="text-body font-medium text-fg">
                No swatches match that search
              </p>
              <p className="mt-1 text-caption text-dim">
                Try another title or format.
              </p>
              <Button
                className="mt-4"
                onClick={() => {
                  onSearch("");
                  onFilter("all");
                }}
              >
                Clear filters
              </Button>
            </div>
          </div>
        ) : compact ? (
          <div className="space-y-2" aria-label="Swatches">
            {visibleItems.map((swatch) => (
              <SwatchRow
                key={swatch.id}
                swatch={swatch}
                onOpen={() => onOpen(swatch)}
              />
            ))}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-3">
              {visibleItems.map((swatch) => (
                <SwatchCard
                  key={swatch.id}
                  swatch={swatch}
                  onOpen={() => onOpen(swatch)}
                />
              ))}
            </div>
            <div className="flex items-center justify-between py-4 text-micro text-dim">
              <span>
                Showing {visibleItems.length} of {items.length} swatches
              </span>
              <span className="font-mono tabular-nums">
                {items.length} total
              </span>
            </div>
          </>
        )}
      </div>
    </main>
  );
}

function ShareBanner({
  status,
  network,
  busy,
  compact,
  onChange,
}: {
  status: SwatchServerStatus | null;
  network: boolean;
  busy: boolean;
  compact: boolean;
  onChange(value: boolean): void;
}) {
  const active = network && !!status?.running && status.network;
  const title = status?.error
    ? "Swatch server is unavailable"
    : network
      ? active
        ? "Network sharing is on"
        : "Starting network sharing"
      : "Network sharing is off";
  const description = status?.error
    ? "Fix the server setting before sharing links."
    : network
      ? active
        ? "People on your network can open a swatch link or scan its QR code."
        : "Swatches will be available on your network when the server starts."
      : "Links open on this computer only.";
  const StatusIcon = network ? WifiHigh : WifiSlash;

  return (
    <section
      className={clsx(
        "flex items-center gap-3 rounded-xl border border-line bg-panel",
        compact ? "mt-4 px-3 py-2.5" : "mt-5 px-4 py-3",
      )}
      aria-label="Network sharing"
    >
      <span
        className={clsx(
          "grid h-9 w-9 shrink-0 place-items-center rounded-lg border",
          active
            ? "border-ok/30 bg-ok/10 text-ok"
            : "border-line bg-elev text-dim",
        )}
      >
        <StatusIcon size={17} aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-ui font-semibold text-fg">{title}</span>
        <span className="mt-0.5 block text-caption text-dim">
          {description}
        </span>
      </span>
      {!compact && active && (
        <Badge tone="ok" className="hidden sm:inline-flex">
          Available on your network
        </Badge>
      )}
      <button
        type="button"
        role="switch"
        aria-checked={network}
        aria-label="Share swatches on your network"
        disabled={busy}
        onClick={() => onChange(!network)}
        className="group flex h-11 w-14 shrink-0 items-center justify-center rounded-lg outline-offset-2 focus-visible:outline-2 focus-visible:outline-crimson disabled:opacity-50"
      >
        <span
          className={clsx(
            "relative h-5 w-9 rounded-full transition-colors",
            network ? "bg-crimson" : "bg-line-strong",
          )}
        >
          <span
            className={clsx(
              "absolute top-[2px] h-4 w-4 rounded-full bg-white transition-all",
              network ? "left-[18px]" : "left-[2px]",
            )}
          />
        </span>
      </button>
    </section>
  );
}

function SwatchSkeleton({ compact }: { compact: boolean }) {
  if (compact) {
    return (
      <div className="space-y-2" aria-label="Loading swatches">
        {Array.from({ length: 4 }, (_, index) => (
          <div
            key={index}
            className="flex h-[74px] animate-pulse items-center gap-3 rounded-xl border border-line bg-panel p-3"
          >
            <div className="h-12 w-14 rounded-lg bg-elev-2" />
            <div className="flex-1 space-y-2">
              <div className="h-3 w-2/3 rounded bg-elev-2" />
              <div className="h-2.5 w-1/2 rounded bg-elev" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div
      className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-3"
      aria-label="Loading swatches"
    >
      {Array.from({ length: 6 }, (_, index) => (
        <div
          key={index}
          className="animate-pulse overflow-hidden rounded-xl border border-line bg-panel"
        >
          <div className="h-[168px] bg-elev" />
          <div className="space-y-3 p-3.5">
            <div className="h-3 w-2/3 rounded bg-elev-2" />
            <div className="h-2.5 w-1/2 rounded bg-elev" />
            <div className="h-px bg-elev-2" />
            <div className="h-2 w-1/3 rounded bg-elev" />
          </div>
        </div>
      ))}
    </div>
  );
}

function SwatchCard({ swatch, onOpen }: { swatch: Swatch; onOpen(): void }) {
  const { label, icon: FormatIcon } = FORMAT[swatch.format];
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open ${swatch.title}, ${label.toLowerCase()}`}
      className="group min-w-0 overflow-hidden rounded-xl border border-line bg-panel text-left outline-offset-2 transition-[transform,border-color,background-color] hover:-translate-y-0.5 hover:border-line-strong hover:bg-elev focus-visible:outline-2 focus-visible:outline-crimson"
    >
      <SwatchArt swatch={swatch} />
      <span className="block p-3.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-ui font-semibold text-fg">
            {swatch.title}
          </span>
          <Badge className="shrink-0 font-mono tabular-nums">
            v{swatch.version}
          </Badge>
        </span>
        <span className="mt-1.5 flex items-center gap-2 text-caption text-dim">
          <span>{label}</span>
          <span
            aria-hidden="true"
            className="h-0.5 w-0.5 rounded-full bg-dim"
          />
          <span>Updated {timeAgo(swatch.updatedAt)}</span>
        </span>
        <span className="mt-3 flex items-center justify-between border-t border-line pt-2.5 text-caption text-dim">
          <span className="flex min-w-0 items-center gap-1.5 truncate">
            <FormatIcon size={13} aria-hidden="true" />
            {swatch.format === "mockup"
              ? `${swatch.boards ?? 0} screens`
              : formatBytes(swatch.bytes)}
          </span>
          <CaretRight
            size={14}
            className="shrink-0 text-dim transition-transform group-hover:translate-x-0.5 group-hover:text-fg"
            aria-hidden="true"
          />
        </span>
      </span>
    </button>
  );
}

function SwatchRow({ swatch, onOpen }: { swatch: Swatch; onOpen(): void }) {
  const { label, icon: FormatIcon } = FORMAT[swatch.format];
  const image = useCover(swatch);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open ${swatch.title}, ${label.toLowerCase()}`}
      className="flex min-h-[76px] w-full min-w-0 items-center gap-3 overflow-hidden rounded-xl border border-line bg-panel p-2.5 text-left outline-offset-2 transition-colors hover:border-line-strong hover:bg-elev focus-visible:outline-2 focus-visible:outline-crimson active:bg-elev-2"
    >
      <span
        className={clsx(
          "grid h-12 w-14 shrink-0 place-items-center overflow-hidden rounded-lg border border-line-strong bg-gradient-to-br",
          FORMAT[swatch.format].cover,
        )}
      >
        {image ? (
          <img
            src={image}
            alt=""
            draggable={false}
            className="h-full w-full bg-white object-cover object-top"
          />
        ) : (
          <FormatIcon size={21} className="text-fg" aria-hidden="true" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui font-semibold text-fg">
          {swatch.title}
        </span>
        <span className="mt-1 block truncate text-caption text-dim">
          {label} · updated {timeAgo(swatch.updatedAt)}
        </span>
      </span>
      <Badge className="shrink-0 font-mono tabular-nums">
        v{swatch.version}
      </Badge>
      <CaretRight size={15} className="shrink-0 text-dim" aria-hidden="true" />
    </button>
  );
}

/** The picture on a swatch's card: its first board or the page as rendered; null until made (in the background). */
function useCover(swatch: Swatch): string | null {
  const [cover, setCover] = useState<string | null>(null);
  const load = () =>
    void api.swatches.cover(swatch.id).then(setCover, () => setCover(null));
  useEffect(load, [swatch.id, swatch.version]); // eslint-disable-line react-hooks/exhaustive-deps
  useEvent("swatches", (event) => {
    // Made, or the server it is rendered from has just started.
    if ((event.type === "thumbs" && event.id === swatch.id) || event.type === "status") load();
  });
  return cover;
}

function SwatchArt({ swatch }: { swatch: Swatch }) {
  const { label, icon: FormatIcon, cover } = FORMAT[swatch.format];
  const image = useCover(swatch);
  return (
    <span
      className={clsx(
        "relative block h-[168px] overflow-hidden border-b border-line bg-gradient-to-br",
        cover,
      )}
    >
      <span className="absolute left-3 top-3 z-10 inline-flex items-center gap-1.5 rounded-md border border-line-strong bg-bg/90 px-1.5 py-1 text-micro font-medium text-fg">
        <FormatIcon size={12} aria-hidden="true" />
        {label.toUpperCase()}
        {swatch.format === "svg"
          ? " · SVG"
          : swatch.format === "mockup"
            ? ` · ${swatch.boards ?? 0} SCREENS`
            : ""}
      </span>
      {image ? (
        <img
          src={image}
          alt=""
          draggable={false}
          className="absolute inset-0 h-full w-full bg-white object-cover object-top transition-transform duration-300 group-hover:scale-[1.02]"
        />
      ) : (
        <SwatchPlaceholder swatch={swatch} />
      )}
    </span>
  );
}

/** Stand-in art for a card while its picture is made (or when it can't be). */
function SwatchPlaceholder({ swatch }: { swatch: Swatch }) {
  return (
    <>
      {swatch.format === "html" && (
        <span
          className="absolute inset-x-4 bottom-3 flex h-12 items-end gap-1.5"
          aria-hidden="true"
        >
          {CHART_BARS.map((height, index) => (
            <i
              key={index}
              style={{ height: `${height}%` }}
              className="flex-1 rounded-t-sm bg-crimson/70"
            />
          ))}
        </span>
      )}
      {swatch.format === "markdown" && (
        <span
          className="absolute inset-x-1/4 top-5 bottom-0 rounded-t-md border border-[#d6d4cf] bg-[#e7e4df] p-3 shadow-lg shadow-black/20"
          aria-hidden="true"
        >
          <span className="mb-2 block h-2 w-3/4 rounded bg-[#57575a]" />
          <span className="mb-1.5 block h-1 w-full rounded bg-[#bbb9b5]" />
          <span className="mb-1.5 block h-1 w-4/5 rounded bg-[#c7c5c0]" />
          <span className="mb-1.5 block h-1 w-2/3 rounded bg-[#c7c5c0]" />
        </span>
      )}
      {swatch.format === "svg" && (
        <span
          className="absolute inset-x-3 bottom-3 flex gap-2"
          aria-hidden="true"
        >
          {IMAGE_SWATCHES.map((color) => (
            <i
              key={color}
              className={clsx(
                "h-8 flex-1 rounded-md border border-white/20 shadow-sm",
                color,
              )}
            />
          ))}
        </span>
      )}
      {swatch.format === "mockup" && (
        <span
          className="absolute inset-x-0 bottom-[-1px] flex justify-center gap-1.5"
          aria-hidden="true"
        >
          {Array.from(
            { length: Math.min(Math.max(swatch.boards ?? 3, 2), 4) },
            (_, index) => (
              <i
                key={index}
                className={clsx(
                  "h-[76px] w-[22%] rounded-t-md border border-line-strong bg-bg/80 p-1.5 shadow-md",
                  index === 1 && "translate-y-[-5px]",
                )}
              >
                <i className="block h-1.5 w-2/3 rounded bg-crimson/80" />
                <i className="mt-2 block h-4 rounded-sm bg-elev-2" />
                <i className="mt-1 block h-5 rounded-sm bg-elev" />
              </i>
            ),
          )}
        </span>
      )}
    </>
  );
}

function EmptyLibrary({
  compact,
  onOpenChat,
}: {
  compact: boolean;
  onOpenChat(): void;
}) {
  const [showExamples, setShowExamples] = useState(false);
  return (
    <section
      className={clsx(
        "mx-auto grid w-full max-w-4xl items-center gap-6 rounded-xl border border-line bg-panel p-5 sm:grid-cols-2 sm:p-8",
        compact && "grid-cols-1 p-4",
      )}
    >
      <div
        className={clsx(
          "relative flex h-44 items-center justify-center overflow-hidden rounded-lg bg-gradient-to-br from-elev to-bg",
          compact && "h-32",
        )}
        aria-hidden="true"
      >
        <div className="absolute h-40 w-40 rounded-full bg-crimson/10 blur-3xl" />
        <div className="relative flex items-center gap-2">
          <div className="-rotate-6 rounded-lg border border-line-strong bg-panel p-3 shadow-xl">
            <FileText size={25} className="text-muted" />
            <span className="mt-2 block h-1 w-12 rounded bg-elev-2" />
            <span className="mt-1.5 block h-1 w-9 rounded bg-elev-2" />
          </div>
          <div className="z-10 translate-y-2 rounded-lg border border-crimson-line bg-panel p-3 shadow-xl">
            <SwatchesIcon size={25} className="text-crimson-text" />
            <span className="mt-2 block h-1 w-14 rounded bg-crimson/60" />
            <span className="mt-1.5 block h-1 w-10 rounded bg-elev-2" />
          </div>
          <div className="rotate-6 rounded-lg border border-line-strong bg-panel p-3 shadow-xl">
            <SquaresFour size={25} className="text-muted" />
            <span className="mt-2 block h-1 w-11 rounded bg-elev-2" />
            <span className="mt-1.5 block h-1 w-8 rounded bg-elev-2" />
          </div>
        </div>
      </div>
      <div>
        <p className="text-micro font-semibold uppercase tracking-[0.1em] text-crimson-text">
          Your library is ready
        </p>
        <h2 className="mt-2 text-section font-semibold tracking-tight text-fg">
          No swatches yet
        </h2>
        <p className="mt-2 max-w-md text-ui leading-relaxed text-muted">
          Ask a chat for a report, dashboard, diagram or small tool. Say "as a
          swatch" and it will be saved here.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            variant="primary"
            icon={<ChatCircleDots size={14} />}
            onClick={onOpenChat}
          >
            Open Chat
          </Button>
          <Button
            variant="outline"
            onClick={() => setShowExamples((value) => !value)}
            aria-expanded={showExamples}
          >
            See examples
          </Button>
        </div>
        {showExamples && (
          <p className="mt-3 rounded-lg border border-line bg-bg px-3 py-2 text-caption text-dim">
            Try a usage report, project dashboard, architecture diagram, SVG
            graphic or small interactive tool.
          </p>
        )}
        <p className="mt-3 text-micro text-dim">
          Swatches stay on this computer unless network sharing is on.
        </p>
      </div>
    </section>
  );
}

function SwatchDetail({
  swatch,
  network,
  status,
  onBack,
  onNetworkChange,
}: {
  swatch: Swatch;
  network: boolean;
  status: SwatchServerStatus | null;
  onBack(): void;
  onNetworkChange(value: boolean): void;
}) {
  const [links, setLinks] = useState<SwatchLink[]>([]);
  const [linksLoading, setLinksLoading] = useState(true);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [linkRevision, setLinkRevision] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(swatch.title);
  const [moreOpen, setMoreOpen] = useState(false);
  const localLink = links.find((link) => link.kind === "local");
  const sharedLink = links.find((link) => link.kind !== "local");
  const copyLink = sharedLink ?? localLink;
  const preview = isMobile ? sharedLink : localLink;
  const { label, icon: FormatIcon } = FORMAT[swatch.format];

  useEffect(() => {
    let live = true;
    setLinksLoading(true);
    setLinkError(null);
    setQr(null);
    void api.swatches
      .links(swatch.id)
      .then(async (nextLinks) => {
        if (!live) return;
        setLinks(nextLinks);
        const networkLink = network
          ? nextLinks.find((link) => link.kind !== "local")
          : undefined;
        if (networkLink) {
          try {
            const data = await QRCode.toDataURL(networkLink.url, {
              margin: 1,
              width: 240,
              errorCorrectionLevel: "M",
              color: { dark: "#09090c", light: "#ffffff" },
            });
            if (live) setQr(data);
          } catch (error) {
            if (live)
              setLinkError(
                error instanceof Error ? error.message : String(error),
              );
          }
        }
        if (live) setLinksLoading(false);
      })
      .catch((error: unknown) => {
        if (!live) return;
        setLinkError(error instanceof Error ? error.message : String(error));
        setLinksLoading(false);
      });
    return () => {
      live = false;
    };
  }, [swatch.id, swatch.version, network, linkRevision]);

  const copy = (url: string) =>
    void attempt(() => navigator.clipboard.writeText(url), "Link copied");

  const saveTitle = async () => {
    const title = draftTitle.trim();
    setEditing(false);
    if (title && title !== swatch.title)
      await attempt(() => api.swatches.rename(swatch.id, title));
  };

  const remove = async () => {
    const confirmed = await confirmAction(
      `Delete "${swatch.title}"? Its links stop working everywhere. This cannot be undone.`,
      {
        title: "Delete swatch?",
        danger: true,
        confirmLabel: "Delete",
      },
    );
    if (!confirmed) return;
    await attempt(() => api.swatches.remove(swatch.id));
    useSwatchNav.setState({ selected: null });
    onBack();
  };

  const newLink = async () => {
    const confirmed = await confirmAction(
      "Make a new link for this swatch? Links you shared before will stop working.",
      {
        title: "Make a new link?",
        confirmLabel: "Make new link",
      },
    );
    if (!confirmed) return;
    const nextLinks = await attempt(() => api.swatches.newLink(swatch.id));
    if (nextLinks) {
      setLinks(nextLinks);
      setLinkRevision((revision) => revision + 1);
    }
  };

  const saveAs = async () => {
    const saved = await attempt(() => api.swatches.saveAs(swatch.id));
    if (saved) useApp.getState().toast("Swatch saved", "ok");
  };

  return (
    <main className="flex h-full min-h-0 flex-col bg-bg">
      <header className="shrink-0 border-b border-line px-4 py-3 sm:px-5 lg:px-8">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md px-2 text-caption text-muted transition-colors hover:bg-elev hover:text-fg focus-visible:outline-2 focus-visible:outline-crimson"
          >
            <ArrowLeft size={15} aria-hidden="true" />
            Swatches
          </button>
          <span className="h-5 w-px bg-line" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            {editing ? (
              <Input
                autoFocus
                aria-label="Swatch name"
                value={draftTitle}
                onChange={(event) => setDraftTitle(event.target.value)}
                onBlur={() => void saveTitle()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.blur();
                  }
                  if (event.key === "Escape") {
                    setDraftTitle(swatch.title);
                    setEditing(false);
                  }
                }}
                className="h-8 max-w-lg text-section font-semibold"
              />
            ) : (
              <h1 className="truncate text-section font-semibold tracking-tight text-fg">
                {swatch.title}
              </h1>
            )}
            <p className="mt-0.5 truncate text-caption text-dim">
              Updated {timeAgo(swatch.updatedAt)}
            </p>
          </div>
          <div className="flex w-full items-center gap-2 sm:w-auto">
            {copyLink && (
              <Button
                size="sm"
                variant="outline"
                icon={<Copy size={13} />}
                onClick={() => copy(copyLink.url)}
              >
                Copy link
              </Button>
            )}
            {localLink && !isMobile && (
              <Button
                size="sm"
                icon={<ArrowSquareOut size={13} />}
                onClick={() => void api.app.openExternal(localLink.url)}
              >
                Open in browser
              </Button>
            )}
            <div
              className="relative"
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget))
                  setMoreOpen(false);
              }}
            >
              <IconButton
                title="More actions"
                aria-label="More actions"
                aria-expanded={moreOpen}
                onClick={() => setMoreOpen((value) => !value)}
                className="h-8 w-8 border border-line"
              >
                <DotsThree size={18} />
              </IconButton>
              {moreOpen && (
                <div
                  role="menu"
                  className="absolute right-0 top-10 z-20 min-w-44 rounded-lg border border-line-strong bg-panel p-1 shadow-xl shadow-black/40"
                >
                  <ActionMenuItem
                    icon={<PencilSimple size={14} />}
                    onClick={() => {
                      setMoreOpen(false);
                      setDraftTitle(swatch.title);
                      setEditing(true);
                    }}
                  >
                    Rename
                  </ActionMenuItem>
                  {!isMobile && (
                    <ActionMenuItem
                      icon={<DownloadSimple size={14} />}
                      onClick={() => {
                        setMoreOpen(false);
                        void saveAs();
                      }}
                    >
                      Save as a file
                    </ActionMenuItem>
                  )}
                  <ActionMenuItem
                    icon={<LinkSimple size={14} />}
                    onClick={() => {
                      setMoreOpen(false);
                      void newLink();
                    }}
                  >
                    Make a new link
                  </ActionMenuItem>
                  <div className="my-1 border-t border-line" />
                  <ActionMenuItem
                    icon={<Trash size={14} />}
                    danger
                    onClick={() => {
                      setMoreOpen(false);
                      void remove();
                    }}
                  >
                    Delete swatch
                  </ActionMenuItem>
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3 text-caption text-dim">
          <Badge>
            <FormatIcon size={12} aria-hidden="true" />
            {label}
          </Badge>
          <span>Version {swatch.version}</span>
          <span className="h-3 w-px bg-line" aria-hidden="true" />
          <span>
            {swatch.format === "mockup"
              ? `${swatch.boards ?? 0} screens`
              : formatBytes(swatch.bytes)}
          </span>
          <span className="h-3 w-px bg-line" aria-hidden="true" />
          <span>Latest version</span>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5 lg:px-8">
        <div className="grid min-h-full grid-cols-1 items-start gap-4 lg:h-full lg:grid-cols-[270px_minmax(0,1fr)] lg:items-stretch">
          <aside className="space-y-3 lg:overflow-y-auto">
            <section className="overflow-hidden rounded-xl border border-line bg-panel">
              <div className="flex items-center justify-between gap-2 border-b border-line px-3.5 py-3">
                <h2 className="text-ui font-semibold text-fg">
                  Share this swatch
                </h2>
                <Badge tone="dim">Private link</Badge>
              </div>
              <div className="space-y-3 p-3.5">
                {linksLoading ? (
                  <p className="text-caption text-dim">Loading links…</p>
                ) : linkError && links.length === 0 ? (
                  <p className="text-caption text-danger-hi" role="alert">
                    {linkError}
                  </p>
                ) : links.length ? (
                  links.map((link) => (
                    <ShareLinkRow
                      key={link.url}
                      link={link}
                      onCopy={() => copy(link.url)}
                    />
                  ))
                ) : (
                  <p className="text-caption text-dim">
                    No links are available yet.
                  </p>
                )}
                <div className="border-t border-line pt-3">
                  <div className="flex items-center gap-2">
                    <span
                      className={clsx(
                        "h-2 w-2 shrink-0 rounded-full",
                        network && status?.running && status.network
                          ? "bg-ok"
                          : "bg-dim",
                      )}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-caption font-medium text-fg">
                        Network sharing {network ? "on" : "off"}
                      </span>
                      <span className="mt-0.5 block text-micro text-dim">
                        {network
                          ? "Available on this network"
                          : "Links work on this computer only"}
                      </span>
                    </span>
                    <NetworkSwitch
                      checked={network}
                      onChange={onNetworkChange}
                    />
                  </div>
                </div>
                {network && sharedLink && qr && (
                  <div className="flex items-center gap-3 rounded-lg bg-elev p-2.5">
                    <img
                      src={qr}
                      alt={`QR code for the ${sharedLink.label} link`}
                      className="h-14 w-14 rounded bg-white p-1"
                    />
                    <span className="text-caption leading-relaxed text-muted">
                      <strong className="mb-0.5 block font-medium text-fg">
                        Open on a phone
                      </strong>
                      Scan while connected to the same network.
                    </span>
                  </div>
                )}
                {network && status?.error && (
                  <p className="text-caption text-danger-hi" role="alert">
                    {status.error}
                  </p>
                )}
              </div>
            </section>

            <section className="overflow-hidden rounded-xl border border-line bg-panel">
              <div className="border-b border-line px-3.5 py-3">
                <h2 className="text-ui font-semibold text-fg">Details</h2>
              </div>
              <dl className="divide-y divide-line px-3.5">
                <DetailRow label="Format" value={label} />
                <DetailRow
                  label="Created"
                  value={new Date(swatch.createdAt).toLocaleDateString()}
                />
                <DetailRow label="Versions" value={`${swatch.version} saved`} />
              </dl>
            </section>
          </aside>

          {swatch.format === "mockup" && preview ? (
            <section
              className="flex h-[80vh] min-h-[480px] flex-col overflow-hidden rounded-xl border border-line bg-bg lg:h-full"
              aria-label="Mockup preview"
            >
              <MockupCanvas
                swatch={swatch}
                base={preview.url}
                compact={isMobile}
              />
            </section>
          ) : (
            <PreviewPanel
              swatch={swatch}
              preview={preview}
              isMobile={isMobile}
            />
          )}
        </div>
      </div>
    </main>
  );
}

function NetworkSwitch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange(value: boolean): void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label="Share swatches on your network"
      onClick={() => onChange(!checked)}
      className="flex h-10 w-12 shrink-0 items-center justify-center rounded-md outline-offset-2 focus-visible:outline-2 focus-visible:outline-crimson disabled:opacity-40"
    >
      <span
        className={clsx(
          "relative h-[18px] w-8 rounded-full transition-colors",
          checked ? "bg-crimson" : "bg-line-strong",
        )}
      >
        <span
          className={clsx(
            "absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-all",
            checked ? "left-[16px]" : "left-[2px]",
          )}
        />
      </span>
    </button>
  );
}

function ShareLinkRow({ link, onCopy }: { link: SwatchLink; onCopy(): void }) {
  return (
    <div className="min-w-0">
      <div className="mb-1.5 text-caption text-dim">{link.label}</div>
      <div className="flex min-w-0 items-center rounded-md border border-line bg-bg pl-2.5">
        <code
          className="selectable min-w-0 flex-1 truncate py-2 font-mono text-micro text-muted"
          title={link.url}
        >
          {link.url}
        </code>
        <IconButton
          type="button"
          aria-label={`Copy the ${link.label} link`}
          title="Copy link"
          onClick={onCopy}
          className="h-9 w-9 shrink-0 border-l border-line rounded-none"
        >
          <Copy size={14} />
        </IconButton>
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5 text-caption">
      <dt className="text-dim">{label}</dt>
      <dd className="truncate text-muted">{value}</dd>
    </div>
  );
}

function ActionMenuItem({
  icon,
  children,
  danger,
  onClick,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  danger?: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={clsx(
        "flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-caption transition-colors hover:bg-elev-2",
        danger ? "text-danger-hi" : "text-muted hover:text-fg",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

function PreviewPanel({
  swatch,
  preview,
  isMobile,
}: {
  swatch: Swatch;
  preview: SwatchLink | undefined;
  isMobile: boolean;
}) {
  return (
    <section
      className="flex h-[80vh] min-h-[480px] min-w-0 flex-col overflow-hidden rounded-xl border border-line bg-panel lg:h-full"
      aria-label="Swatch preview"
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3.5">
        <span
          className={clsx("h-2 w-2 rounded-full", preview ? "bg-ok" : "bg-dim")}
          aria-hidden="true"
        />
        <h2 className="text-caption font-medium text-muted">Live preview</h2>
        <span className="ml-auto text-micro text-dim">
          {preview ? "Latest version" : "Not available"}
        </span>
      </div>
      <div className="min-h-0 flex-1 bg-white">
        {preview ? (
          <iframe
            key={`${swatch.id}:${swatch.version}:${preview.url}`}
            src={preview.url}
            title={swatch.title}
            sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
            className="h-full w-full border-0"
          />
        ) : (
          <div className="grid h-full place-items-center bg-bg p-6 text-center">
            <div className="max-w-xs">
              <WifiSlash
                size={24}
                className="mx-auto mb-3 text-dim"
                aria-hidden="true"
              />
              <p className="text-ui font-medium text-fg">
                This swatch is not reachable here
              </p>
              <p className="mt-1.5 text-caption leading-relaxed text-dim">
                {isMobile
                  ? "Turn on network sharing on the computer running Cloth to open this swatch on your phone."
                  : "The swatch server is starting. The preview will appear when it is ready."}
              </p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
