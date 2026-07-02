import { useCallback } from "react";
import { toast } from "sonner";
import { useScopedT } from "@/contexts/I18nContext";

/** Toast feedback for timeline copy/paste (issue #29). */
export function useClipboardFeedback() {
	const t = useScopedT("timeline");

	const notifyCopied = useCallback(() => {
		toast.success(t("feedback.copied"));
	}, [t]);

	const notifyPasted = useCallback(() => {
		toast.success(t("feedback.pasted"));
	}, [t]);

	return { notifyCopied, notifyPasted };
}
