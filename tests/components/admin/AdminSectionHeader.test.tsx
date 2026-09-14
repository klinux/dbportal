import "../../setup-dom";
import { describe, test, expect, afterEach } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import { Database } from "lucide-react";
import { AdminSectionHeader } from "@/components/admin/AdminSectionHeader";

/**
 * The one heading every admin section opens with: the seven sections had drifted to three
 * heading sizes and one page with a bar of its own, so the shape is pinned here once.
 */
describe("AdminSectionHeader", () => {
  afterEach(() => {
    cleanup();
  });

  test("renders the icon, the title as the section's h2, the description and the actions", () => {
    const { getByRole, getByText, getByTestId } = render(
      <AdminSectionHeader
        icon={Database}
        title="Shared datasources"
        description="Declared once."
        actions={<button type="button">New</button>}
        testId="datasources-header"
      />,
    );
    const heading = getByRole("heading", { level: 2 });
    expect(heading.textContent).toBe("Shared datasources");
    expect(heading.className).toContain("text-base");
    expect(heading.querySelector("svg")).not.toBeNull();
    expect(getByText("Declared once.").className).toContain("text-fg-tertiary");
    expect(getByText("New")).not.toBeNull();
    expect(getByTestId("datasources-header")).not.toBeNull();
  });

  test("a title alone renders neither a description paragraph nor an empty actions slot", () => {
    const { container, getByTestId } = render(<AdminSectionHeader icon={Database} title="Audit" />);
    expect(container.querySelector("p")).toBeNull();
    expect(getByTestId("admin-section-header").children.length).toBe(1);
  });
});
