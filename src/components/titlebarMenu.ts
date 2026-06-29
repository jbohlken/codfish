import { signal } from "@preact/signals";

// The id of the currently-open title-bar dropdown (a SelectButton / ActionMenuButton
// given a `menuId`), or null. Single-owner: opening one closes the others, and
// hovering across them while one is open swaps to the hovered one — like a native
// menu bar. Dropdowns without a `menuId` keep their own independent open state.
export const openTitlebarMenu = signal<string | null>(null);
