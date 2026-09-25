/**
 * Quotes a Google Sheets tab title for use in an A1-notation range. A1 notation requires a sheet
 * name to be single-quoted whenever it contains anything but letters/digits/underscore (e.g. a
 * space) — passing a raw title like "My Tab" as the range is invalid. Always quoting is valid
 * regardless of the title's contents, and any embedded single quote is escaped by doubling it.
 */
export function quoteSheetTitle(title: string): string {
    return `'${title.replace(/'/g, "''")}'`;
}
