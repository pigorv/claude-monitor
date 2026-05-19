import { html } from "htm/preact";
import type { RefObject } from "preact";
import { Dropdown } from "./Dropdown";
import { projectColor } from "../lib/format";
import type { ProjectInfo } from "../../../src/shared/types";
import "../styles/filter-bar.css";

interface FilterBarProps {
  searchRef?: RefObject<HTMLInputElement>;
  searchQuery: string;
  onSearch: (e: Event) => void;

  projects: ProjectInfo[];
  selectedProject: string | null;
  onSelectProject: (path: string | null) => void;

  modelFilter: string;
  onModelFilter: (v: string) => void;

  sortCol: string;
  sortOrder: string;
  onApplySort: (col: string, order: string) => void;

  total: number;
  loading: boolean;
  hasActiveFilters: boolean;
  onResetFilters: () => void;
}

const MODEL_OPTIONS = [
  { value: "all",    label: "All models" },
  { value: "opus",   label: "Opus",   swatch: "var(--purple)" },
  { value: "sonnet", label: "Sonnet", swatch: "var(--accent)" },
  { value: "haiku",  label: "Haiku",  swatch: "var(--text3)" },
];

const SORT_OPTIONS = [
  { value: "started_at:desc",        label: "↓ Latest" },
  { value: "started_at:asc",         label: "↑ Oldest" },
  { value: "duration_ms:desc",       label: "↓ Longest duration" },
  { value: "duration_ms:asc",        label: "↑ Shortest duration" },
  { value: "peak_context_pct:desc",  label: "↓ Highest ctx %" },
  { value: "peak_context_pct:asc",   label: "↑ Lowest ctx %" },
  { value: "cost_estimate_usd:desc", label: "↓ Most expensive" },
  { value: "cost_estimate_usd:asc",  label: "↑ Cheapest" },
  { value: "project_name:asc",       label: "Project A→Z" },
  { value: "model:asc",              label: "Model A→Z" },
];

export function FilterBar(props: FilterBarProps) {
  const {
    searchRef,
    searchQuery,
    onSearch,
    projects,
    selectedProject,
    onSelectProject,
    modelFilter,
    onModelFilter,
    sortCol,
    sortOrder,
    onApplySort,
    total,
    loading,
    hasActiveFilters,
    onResetFilters,
  } = props;

  const projectOptions = [
    { value: "", label: "All projects" },
    ...projects.map((p) => ({
      value: p.project_path,
      label:
        p.project_name.length > 28
          ? p.project_name.slice(0, 28) + "…"
          : p.project_name,
      swatch: projectColor(p.project_name || "default"),
      trailing: p.session_count,
    })),
  ];

  const selectedProjectInfo = selectedProject
    ? projects.find((p) => p.project_path === selectedProject)
    : null;
  const rawProjectLabel = selectedProjectInfo?.project_name ?? (selectedProject ? "Project" : "All projects");
  const projectLabel =
    rawProjectLabel.length > 18
      ? rawProjectLabel.slice(0, 18) + "…"
      : rawProjectLabel;
  const projectTriggerSwatch = selectedProjectInfo
    ? projectColor(selectedProjectInfo.project_name || "default")
    : undefined;

  const selectedModel = MODEL_OPTIONS.find((o) => o.value === modelFilter);
  const modelLabel = selectedModel?.label ?? "Model";
  const modelTriggerSwatch = selectedModel?.swatch;

  const sortValue = `${sortCol}:${sortOrder}`;
  const sortLabel =
    SORT_OPTIONS.find((o) => o.value === sortValue)?.label ?? "Sort";

  return html`
    <div class="filter-bar">
      <div class="filter-bar-search">
        <input
          ref=${searchRef}
          class="search-input"
          placeholder="Search sessions…"
          value=${searchQuery}
          onInput=${onSearch}
        />
        <kbd class="search-kbd" aria-hidden="true">/</kbd>
      </div>

      <${Dropdown}
        label=${projectLabel}
        options=${projectOptions}
        value=${selectedProject ?? ""}
        onChange=${(v: string) => onSelectProject(v || null)}
        triggerSwatch=${projectTriggerSwatch}
        typeahead=${projects.length > 8}
      />

      <${Dropdown}
        label=${modelLabel}
        options=${MODEL_OPTIONS}
        value=${modelFilter}
        onChange=${onModelFilter}
        triggerSwatch=${modelTriggerSwatch}
      />

      <${Dropdown}
        label=${sortLabel}
        options=${SORT_OPTIONS}
        value=${sortValue}
        onChange=${(v: string) => {
          const colonIdx = v.indexOf(":");
          onApplySort(v.slice(0, colonIdx), v.slice(colonIdx + 1));
        }}
      />

      <span class=${`filter-bar-count${loading ? " filter-bar-count-pulse" : ""}`}>
        ${loading ? "…" : `${total}`}
      </span>

      ${hasActiveFilters &&
        html`
          <button
            class="reset-filters"
            onClick=${onResetFilters}
            title="Clear all filters"
          >
            <span class="reset-x" aria-hidden="true">×</span>
            Clear filters
          </button>
        `}
    </div>
  `;
}
