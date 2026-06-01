import { describe, it, expect, beforeEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/preact";

import { NoticeModal, noticeModal, showNotice } from "../NoticeModal";

beforeEach(() => {
  cleanup();
  noticeModal.value = null;
});

describe("NoticeModal", () => {
  it("renders nothing when noticeModal.value is null", () => {
    const { container } = render(<NoticeModal />);
    expect(container.querySelector(".notice-modal")).toBeNull();
    expect(container.querySelector(".notice-modal-backdrop")).toBeNull();
  });

  it("showNotice renders title and message into the modal", () => {
    showNotice("Title", "Body");
    const { container } = render(<NoticeModal />);
    expect(container.querySelector(".notice-modal-title")?.textContent).toBe("Title");
    expect(container.querySelector(".notice-modal-body")?.textContent).toBe("Body");
  });

  it("OK button click dismisses the modal", () => {
    showNotice("T", "B");
    const { container } = render(<NoticeModal />);
    const okBtn = Array.from(
      container.querySelectorAll(".notice-modal-footer button"),
    ).find((b) => b.textContent === "OK") as HTMLButtonElement;
    expect(okBtn).toBeTruthy();
    fireEvent.click(okBtn);
    expect(noticeModal.value).toBeNull();
    // Modal unmounts on re-render
    expect(container.querySelector(".notice-modal")).toBeNull();
  });

  it("backdrop click dismisses the modal", () => {
    showNotice("T", "B");
    const { container } = render(<NoticeModal />);
    const backdrop = container.querySelector(".notice-modal-backdrop") as HTMLElement;
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop);
    expect(noticeModal.value).toBeNull();
  });

  it("clicking the inner card does NOT dismiss the modal (stopPropagation)", () => {
    showNotice("T", "B");
    const { container } = render(<NoticeModal />);
    const card = container.querySelector(".notice-modal") as HTMLElement;
    expect(card).toBeTruthy();
    fireEvent.click(card);
    expect(noticeModal.value).not.toBeNull();
    expect(container.querySelector(".notice-modal")).not.toBeNull();
  });

  it("X (close icon) button dismisses the modal", () => {
    showNotice("T", "B");
    const { container } = render(<NoticeModal />);
    const closeBtn = container.querySelector(
      ".notice-modal-header button",
    ) as HTMLButtonElement;
    expect(closeBtn).toBeTruthy();
    fireEvent.click(closeBtn);
    expect(noticeModal.value).toBeNull();
  });

  it("footer contains exactly one button labeled 'OK' (regression: no Cancel)", () => {
    showNotice("T", "B");
    const { container } = render(<NoticeModal />);
    const footerButtons = container.querySelectorAll(".notice-modal-footer button");
    expect(footerButtons).toHaveLength(1);
    expect(footerButtons[0].textContent).toBe("OK");
  });
});
