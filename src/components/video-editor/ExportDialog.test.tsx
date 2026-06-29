import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExportProgress } from "@/lib/exporter";
import { ExportDialog } from "./ExportDialog";

// Identity scoped-translator so assertions can match on raw i18n keys.
vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string) => key,
}));

afterEach(cleanup);

const exportingProgress = { percentage: 40, currentFrame: 4, totalFrames: 10 } as ExportProgress;

const baseProps = {
	isOpen: true,
	onClose: vi.fn(),
	progress: null,
	isExporting: false,
	error: null,
};

describe("ExportDialog", () => {
	it("renders an accessible dialog when open", () => {
		render(<ExportDialog {...baseProps} />);
		expect(screen.getByRole("dialog")).toBeTruthy();
	});

	it("renders nothing when closed", () => {
		render(<ExportDialog {...baseProps} isOpen={false} />);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("dismisses on Escape when not exporting", async () => {
		const onClose = vi.fn();
		const user = userEvent.setup();
		render(<ExportDialog {...baseProps} onClose={onClose} />);

		await user.keyboard("{Escape}");

		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("does not dismiss on Escape while exporting", async () => {
		const onClose = vi.fn();
		const user = userEvent.setup();
		render(
			<ExportDialog {...baseProps} isExporting progress={exportingProgress} onClose={onClose} />,
		);

		await user.keyboard("{Escape}");

		expect(onClose).not.toHaveBeenCalled();
	});

	it("shows a close button only when not exporting", () => {
		const { rerender } = render(<ExportDialog {...baseProps} />);
		expect(screen.getByRole("button", { name: "actions.close" })).toBeTruthy();

		rerender(<ExportDialog {...baseProps} isExporting progress={exportingProgress} />);
		expect(screen.queryByRole("button", { name: "actions.close" })).toBeNull();
	});
});
