export const UNCATEGORIZED = "Uncategorized";
const SEPARATOR = " - ";

export function parseThreadTitle(title: string): {
  category: string;
  displayTitle: string;
} {
  const separatorIndex = title.indexOf(SEPARATOR);
  if (separatorIndex <= 0) {
    return { category: UNCATEGORIZED, displayTitle: title };
  }

  const prefix = title.slice(0, separatorIndex).trim();
  if (!prefix) {
    return { category: UNCATEGORIZED, displayTitle: title };
  }

  return {
    category: prefix,
    displayTitle: title.slice(separatorIndex + SEPARATOR.length),
  };
}

export function buildThreadTitle(category: string, displayTitle: string): string {
  return category === UNCATEGORIZED
    ? displayTitle
    : `${category}${SEPARATOR}${displayTitle}`;
}

export function effectiveThreadTitle(
  name: string | null | undefined,
  preview: string | null | undefined,
): string {
  return [name, preview].find((value) => value?.trim())?.trim() ?? "Untitled thread";
}

export function threadCategories(categories: string[]): string[] {
  const unique = [...new Set(categories.filter((category) => category !== UNCATEGORIZED))];
  return [...unique, UNCATEGORIZED];
}
