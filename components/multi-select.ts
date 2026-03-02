/**
 * Multi-Select Component
 *
 * A multi-select UI component built on top of the pager.
 */

import type { ExtensionCommandContext, Theme } from "@mariozechner/pi-coding-agent";
import { pager, PagerItem, PagerState, RenderItemOptions } from "./pager";
import type { Container } from "@mariozechner/pi-tui";
import { matchesKey, Spacer, Text } from "@mariozechner/pi-tui";

// An item in the multi-select list
export interface MultiSelectItem<T> {
    value: T;
    label: string;
    disabled?: boolean;
}

// Options for the multi-select component
export interface MultiSelectOptions<T> {
    // Title shown at the top
    title: string;
    // Items to display
    items: MultiSelectItem<T>[];
    // Pre-selected indices
    initialSelected?: Set<number>;
    // Maximum visible items before scrolling
    maxVisible?: number;
    // Custom render function for item content (cursor marker and checkbox are added automatically)
    renderItem?: (
        item: MultiSelectItem<T>,
        options: MultiSelectRenderOptions<T>,
    ) => string;
    // Optional header content rendered after title
    headerContent?: (container: Container, theme: Theme) => void;
    // Optional footer content rendered before help text
    footerContent?: (container: Container, theme: Theme, state: MultiSelectState<T>) => void;
    // Custom help text (defaults to standard navigation help)
    helpText?: string;
}

// Options passed to renderItem callback
export interface MultiSelectRenderOptions<T> {
    index: number;
    isSelected: boolean;
    isCursor: boolean;
    theme: Theme;
    state: MultiSelectState<T>;
}

// Internal state for the multi-select
export interface MultiSelectState<T> {
    items: MultiSelectItem<T>[];
    cursor: number;
    maxVisibleLines: number;
    selected: Set<number>;
}

// Default render for an item's content (just the label)
function defaultRenderItem<T>(
    item: MultiSelectItem<T>,
    options: MultiSelectRenderOptions<T>,
): string {
    if (options.isCursor) {
        return options.theme.fg("accent", item.label);
    }
    return item.label;
}

// Show multi-select UI and return selected values
export async function multiSelect<T>(
    options: MultiSelectOptions<T>,
    ctx: ExtensionCommandContext,
): Promise<T[]> {
    if (!ctx.hasUI) {
        return [];
    }

    if (options.items.length === 0) {
        return [];
    }

    const maxVisibleLines = options.maxVisible ?? 10;
    const renderItem = options.renderItem ?? defaultRenderItem;
    const helpText = options.helpText ?? "↑/↓ navigate | Space toggle | a all | Enter confirm | Esc cancel";

    // Selection state
    const selected = new Set(options.initialSelected ?? []);
    let confirmed = false;

    // Convert items to PagerItem format
    const pagerItems: PagerItem<T>[] = options.items.map((item) => ({
        value: item.value,
        label: item.label,
        disabled: item.disabled,
    }));

    // Build multi-select state for callbacks
    const getMultiSelectState = (pagerState: PagerState<T>): MultiSelectState<T> => ({
        items: options.items,
        cursor: pagerState.cursor,
        maxVisibleLines: pagerState.maxVisibleLines,
        selected,
    });

    await pager(
        {
            title: options.title,
            items: pagerItems,
            maxVisibleLines,
            helpText,
            headerContent: options.headerContent,
            renderItem: (item, pagerOptions) => {
                const isSelected = selected.has(pagerOptions.index);
                const multiSelectOptions: MultiSelectRenderOptions<T> = {
                    index: pagerOptions.index,
                    isSelected,
                    isCursor: pagerOptions.isCursor,
                    theme: pagerOptions.theme,
                    state: getMultiSelectState(pagerOptions.state),
                };

                const content = renderItem(item, multiSelectOptions);

                // Add checkbox prefix (pager handles cursor marker)
                const checkbox = isSelected ? "[x]" : "[ ]";
                const prefix = pagerOptions.isCursor
                    ? pagerOptions.theme.fg("accent", `${checkbox} `)
                    : `${checkbox} `;

                return prefix + content;
            },
            footerContent: (container, theme, pagerState) => {
                // Selection count
                if (selected.size > 0) {
                    container.addChild(new Spacer(1));
                    container.addChild(
                        new Text(
                            theme.fg("success", `  ${selected.size} item(s) selected`),
                            1,
                            0,
                        ),
                    );
                }

                // Custom footer content if provided
                if (options.footerContent) {
                    options.footerContent(container, theme, getMultiSelectState(pagerState));
                }
            },
            onKey: (key, _state) => {
                if (matchesKey(key, "space")) {
                    if (selected.has(_state.cursor)) {
                        selected.delete(_state.cursor);
                    } else {
                        selected.add(_state.cursor);
                    }
                    return true;
                }

                if (key === "a") {
                    if (selected.size === _state.items.length) {
                        selected.clear();
                    } else {
                        for (let i = 0; i < _state.items.length; i++) {
                            selected.add(i);
                        }
                    }
                    return true;
                }

                if (matchesKey(key, "enter")) {
                    confirmed = true;
                    return false; // Let pager close it
                }

                return false; // Let pager handle other keys
            },
        },
        ctx,
    );

    return confirmed ? Array.from(selected).map((i) => options.items[i]?.value).filter(Boolean) : [];
}
