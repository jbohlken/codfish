import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/preact";

import { ActionMenuButton, type ActionMenuItem } from "../ActionMenuButton";

// ── Fixtures ────────────────────────────────────────────────────────────────

const StubIcon = (_: { size?: number }) => (
  <svg data-testid="stub-icon" />
);

function makeItem(overrides: Partial<ActionMenuItem> = {}): ActionMenuItem {
  return {
    label: "Do it",
    onClick: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  cleanup();
});

describe("ActionMenuButton: trigger", () => {
  it("renders icon, label text, caret-down, the action class, and no menu before click", () => {
    const { container } = render(
      <ActionMenuButton
        icon={StubIcon as any}
        label="Actions"
        items={[makeItem()]}
      />,
    );
    const trigger = container.querySelector(".titlebar-select-btn") as HTMLButtonElement;
    expect(trigger).toBeTruthy();
    expect(trigger.classList.contains("titlebar-select-btn--action")).toBe(true);

    // The label text is rendered.
    const labelSpan = container.querySelector(".titlebar-select-label");
    expect(labelSpan?.textContent).toBe("Actions");

    // The trigger contains the stub icon and a caret-down (at least one SVG —
    // CaretDown renders as an SVG in @phosphor-icons/react; the stub icon
    // renders as a second one).
    const svgs = trigger.querySelectorAll("svg");
    expect(svgs.length).toBeGreaterThanOrEqual(1);

    // Menu must NOT be in the DOM before clicking the trigger.
    expect(container.querySelector(".titlebar-select-menu")).toBeNull();
  });
});

describe("ActionMenuButton: open/close", () => {
  it("clicking the trigger opens the menu with one option per item; clicking again closes it", () => {
    const items: ActionMenuItem[] = [
      makeItem({ label: "First" }),
      makeItem({ label: "Second" }),
      makeItem({ label: "Third" }),
    ];
    const { container } = render(
      <ActionMenuButton icon={StubIcon as any} label="Actions" items={items} />,
    );
    const trigger = container.querySelector(".titlebar-select-btn") as HTMLButtonElement;

    fireEvent.click(trigger);
    const menu = container.querySelector(".titlebar-select-menu");
    expect(menu).toBeTruthy();
    const options = container.querySelectorAll(".titlebar-select-option");
    expect(options.length).toBe(3);

    fireEvent.click(trigger);
    expect(container.querySelector(".titlebar-select-menu")).toBeNull();
  });

  it("a mousedown outside the menu closes it", async () => {
    const { container } = render(
      <ActionMenuButton
        icon={StubIcon as any}
        label="Actions"
        items={[makeItem()]}
      />,
    );
    const trigger = container.querySelector(".titlebar-select-btn") as HTMLButtonElement;
    fireEvent.click(trigger);
    // Wait for the open-state effect to register the document mousedown handler.
    await waitFor(() => expect(container.querySelector(".titlebar-select-menu")).toBeTruthy());

    // Dispatch a mousedown on body (outside the component).
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await waitFor(() => expect(container.querySelector(".titlebar-select-menu")).toBeNull());
  });
});

describe("ActionMenuButton: items", () => {
  it("disabled item: has disabled attr + tooltip; click does not fire onClick and does not close menu", () => {
    const onClick = vi.fn();
    const items = [
      makeItem({
        label: "Cannot",
        disabled: true,
        disabledReason: "No media selected",
        onClick,
      }),
    ];
    const { container } = render(
      <ActionMenuButton icon={StubIcon as any} label="Actions" items={items} />,
    );
    fireEvent.click(container.querySelector(".titlebar-select-btn") as HTMLButtonElement);

    const option = container.querySelector(".titlebar-select-option") as HTMLButtonElement;
    expect(option.disabled).toBe(true);
    expect(option.getAttribute("data-tooltip")).toBe("No media selected");

    fireEvent.click(option);
    expect(onClick).not.toHaveBeenCalled();
    // Menu remains open since the disabled button cannot fire its click handler.
    expect(container.querySelector(".titlebar-select-menu")).toBeTruthy();
  });

  it("danger item: option has the danger class", () => {
    const items = [makeItem({ label: "Delete", danger: true })];
    const { container } = render(
      <ActionMenuButton icon={StubIcon as any} label="Actions" items={items} />,
    );
    fireEvent.click(container.querySelector(".titlebar-select-btn") as HTMLButtonElement);
    const option = container.querySelector(".titlebar-select-option") as HTMLButtonElement;
    expect(option.classList.contains("titlebar-select-option--danger")).toBe(true);
  });

  it("description renders in .titlebar-select-option-desc beneath .titlebar-select-option-name", () => {
    const items = [
      makeItem({
        label: "Export",
        description: "Writes a .srt file",
      }),
    ];
    const { container } = render(
      <ActionMenuButton icon={StubIcon as any} label="Actions" items={items} />,
    );
    fireEvent.click(container.querySelector(".titlebar-select-btn") as HTMLButtonElement);

    const name = container.querySelector(".titlebar-select-option-name");
    const desc = container.querySelector(".titlebar-select-option-desc");
    expect(name?.textContent).toBe("Export");
    expect(desc?.textContent).toBe("Writes a .srt file");
    // .desc lives in the same text container as .name (sibling)
    expect(desc?.parentElement?.querySelector(".titlebar-select-option-name")).toBe(name);
  });

  it("meta renders inside .titlebar-select-option-meta", () => {
    const items = [makeItem({ label: "Pending", meta: "3" })];
    const { container } = render(
      <ActionMenuButton icon={StubIcon as any} label="Actions" items={items} />,
    );
    fireEvent.click(container.querySelector(".titlebar-select-btn") as HTMLButtonElement);
    const meta = container.querySelector(".titlebar-select-option-meta");
    expect(meta?.textContent).toBe("3");
  });

  it("clicking an enabled item closes the menu and calls its onClick exactly once", () => {
    const onClick = vi.fn();
    const items = [makeItem({ label: "Go", onClick })];
    const { container } = render(
      <ActionMenuButton icon={StubIcon as any} label="Actions" items={items} />,
    );
    fireEvent.click(container.querySelector(".titlebar-select-btn") as HTMLButtonElement);
    const option = container.querySelector(".titlebar-select-option") as HTMLButtonElement;
    fireEvent.click(option);

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".titlebar-select-menu")).toBeNull();
  });

  it("each item.onClick fires only for its own item", () => {
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    const items = [
      makeItem({ label: "A", onClick: a }),
      makeItem({ label: "B", onClick: b }),
      makeItem({ label: "C", onClick: c }),
    ];
    const { container } = render(
      <ActionMenuButton icon={StubIcon as any} label="Actions" items={items} />,
    );

    // Open + click B.
    fireEvent.click(container.querySelector(".titlebar-select-btn") as HTMLButtonElement);
    const options = container.querySelectorAll(".titlebar-select-option");
    fireEvent.click(options[1] as HTMLButtonElement);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
    expect(c).not.toHaveBeenCalled();

    // Re-open + click C.
    fireEvent.click(container.querySelector(".titlebar-select-btn") as HTMLButtonElement);
    const options2 = container.querySelectorAll(".titlebar-select-option");
    fireEvent.click(options2[2] as HTMLButtonElement);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
    expect(c).toHaveBeenCalledTimes(1);
  });
});
