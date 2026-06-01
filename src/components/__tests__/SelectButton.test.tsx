import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/preact";

import { SelectButton } from "../SelectButton";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function StubIcon(_props: { size?: number }) {
  return <span data-testid="stub-icon" />;
}

type Opt =
  | { value: string; label: string; menuLabel?: string; meta?: string; badge?: boolean }
  | { separator: true; label?: string };

function basicOptions(): Opt[] {
  return [
    { value: "a", label: "Alpha" },
    { value: "b", label: "Bravo" },
    { value: "c", label: "Charlie" },
  ];
}

beforeEach(() => {
  cleanup();
});

describe("SelectButton: trigger", () => {
  it("renders icon, current value label resolved from options, and caret", () => {
    const { container } = render(
      <SelectButton
        icon={StubIcon as any}
        tooltip="pick one"
        options={basicOptions()}
        value="b"
        onChange={() => {}}
      />,
    );

    const trigger = container.querySelector(".titlebar-select-btn") as HTMLButtonElement;
    expect(trigger).toBeTruthy();
    expect(trigger.getAttribute("data-tooltip")).toBe("pick one");

    // Stub icon present
    expect(container.querySelector('[data-testid="stub-icon"]')).toBeTruthy();

    // Label resolves from options by value
    const label = container.querySelector(".titlebar-select-label") as HTMLElement;
    expect(label.textContent).toBe("Bravo");

    // Trigger contains stub icon, the label span, and a caret child after the label.
    // The exact tag the phosphor caret renders to can vary, so just assert the
    // button has at least one element child after the label.
    const children = Array.from(trigger.children);
    const labelIdx = children.findIndex((c) => c.classList.contains("titlebar-select-label"));
    expect(labelIdx).toBeGreaterThanOrEqual(0);
    expect(children.length).toBeGreaterThan(labelIdx + 1);
  });
});

describe("SelectButton: menu open/close", () => {
  it("does not render the menu before clicking the trigger", () => {
    const { container } = render(
      <SelectButton
        icon={StubIcon as any}
        tooltip="t"
        options={basicOptions()}
        value="a"
        onChange={() => {}}
      />,
    );
    expect(container.querySelector(".titlebar-select-menu")).toBeNull();
  });

  it("renders one .titlebar-select-option per non-separator option on click", () => {
    const { container } = render(
      <SelectButton
        icon={StubIcon as any}
        tooltip="t"
        options={basicOptions()}
        value="a"
        onChange={() => {}}
      />,
    );

    const trigger = container.querySelector(".titlebar-select-btn") as HTMLButtonElement;
    fireEvent.click(trigger);

    const menu = container.querySelector(".titlebar-select-menu");
    expect(menu).toBeTruthy();

    const opts = container.querySelectorAll(".titlebar-select-option");
    expect(opts.length).toBe(3);
    expect(opts[0].textContent).toContain("Alpha");
    expect(opts[1].textContent).toContain("Bravo");
    expect(opts[2].textContent).toContain("Charlie");
  });

  it("clicking an option calls onChange with its value and closes the menu", () => {
    const onChange = vi.fn();
    const { container } = render(
      <SelectButton
        icon={StubIcon as any}
        tooltip="t"
        options={basicOptions()}
        value="a"
        onChange={onChange}
      />,
    );

    fireEvent.click(container.querySelector(".titlebar-select-btn") as HTMLButtonElement);
    const opts = container.querySelectorAll(".titlebar-select-option");
    fireEvent.click(opts[2]);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("c");
    expect(container.querySelector(".titlebar-select-menu")).toBeNull();
  });

  it("outside mousedown closes the menu", () => {
    const { container } = render(
      <SelectButton
        icon={StubIcon as any}
        tooltip="t"
        options={basicOptions()}
        value="a"
        onChange={() => {}}
      />,
    );

    fireEvent.click(container.querySelector(".titlebar-select-btn") as HTMLButtonElement);
    expect(container.querySelector(".titlebar-select-menu")).toBeTruthy();

    // Dispatch a mousedown on document.body (outside the component ref)
    fireEvent.mouseDown(document.body);
    expect(container.querySelector(".titlebar-select-menu")).toBeNull();
  });
});

describe("SelectButton: separators", () => {
  it("renders separator items as .titlebar-select-divider, not .titlebar-select-option", () => {
    const options: Opt[] = [
      { value: "a", label: "Alpha" },
      { separator: true },
      { value: "b", label: "Bravo" },
    ];
    const { container } = render(
      <SelectButton
        icon={StubIcon as any}
        tooltip="t"
        options={options}
        value="a"
        onChange={() => {}}
      />,
    );

    fireEvent.click(container.querySelector(".titlebar-select-btn") as HTMLButtonElement);

    // Only two real options, one divider
    expect(container.querySelectorAll(".titlebar-select-option").length).toBe(2);
    expect(container.querySelectorAll(".titlebar-select-divider").length).toBe(1);
  });

  it("separator.label renders as .titlebar-select-group-label", () => {
    const options: Opt[] = [
      { value: "a", label: "Alpha" },
      { separator: true, label: "Group Two" },
      { value: "b", label: "Bravo" },
    ];
    const { container } = render(
      <SelectButton
        icon={StubIcon as any}
        tooltip="t"
        options={options}
        value="a"
        onChange={() => {}}
      />,
    );

    fireEvent.click(container.querySelector(".titlebar-select-btn") as HTMLButtonElement);

    const groupLabel = container.querySelector(".titlebar-select-group-label");
    expect(groupLabel).toBeTruthy();
    expect(groupLabel?.textContent).toBe("Group Two");
  });
});

describe("SelectButton: footer", () => {
  it("renders the footer slot inside the menu separated by a divider", () => {
    const { container } = render(
      <SelectButton
        icon={StubIcon as any}
        tooltip="t"
        options={basicOptions()}
        value="a"
        onChange={() => {}}
        footer={(close) => (
          <button class="my-footer" onClick={close}>
            Footer Action
          </button>
        )}
      />,
    );

    fireEvent.click(container.querySelector(".titlebar-select-btn") as HTMLButtonElement);

    const menu = container.querySelector(".titlebar-select-menu") as HTMLElement;
    expect(menu).toBeTruthy();

    // Footer rendered inside the menu
    const footer = menu.querySelector(".my-footer");
    expect(footer).toBeTruthy();
    expect(footer?.textContent).toBe("Footer Action");

    // There is at least one divider in the menu (the footer separator)
    expect(menu.querySelectorAll(".titlebar-select-divider").length).toBeGreaterThanOrEqual(1);
  });
});

describe("SelectButton: active option", () => {
  it("the option matching value gets .titlebar-select-option--active", () => {
    const { container } = render(
      <SelectButton
        icon={StubIcon as any}
        tooltip="t"
        options={basicOptions()}
        value="b"
        onChange={() => {}}
      />,
    );

    fireEvent.click(container.querySelector(".titlebar-select-btn") as HTMLButtonElement);

    const active = container.querySelectorAll(".titlebar-select-option--active");
    expect(active.length).toBe(1);
    expect(active[0].textContent).toContain("Bravo");
  });
});
