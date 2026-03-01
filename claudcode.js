// ==UserScript==
// @name         ChatGPT - Delete Chats Older Than 5 Months
// @namespace    https://github.com/userscripts/chatgpt-cleanup
// @version      1.0.0
// @description  Delete ChatGPT conversations older than 5 months via backend API (soft delete)
// @author       Senior Browser Automation Dev
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
	"use strict";

	// ============================================================
	// CONFIGURATION - Modify these as needed
	// ============================================================
	const DRY_RUN = true; // Set to false to actually delete
	const USE_UPDATE_TIME = true; // true = filter by update_time, false = create_time
	const INCLUDE_ARCHIVED = false; // true = also fetch archived chats
	const DELETE_DELAY_MS = 250; // Delay between delete requests (ms)
	const PAGE_LIMIT = 100; // Conversations per page
	const MAX_RETRIES = 3; // Retries on 429/5xx
	// ============================================================

	const BUTTON_ID = "gpt-cleanup-btn";
	let isRunning = false;

	// Calculate cutoff date: 5 months ago from now (local time)
	function getCutoffDate() {
		const d = new Date();
		d.setMonth(d.getMonth() - 5);
		return d;
	}

	// Sleep utility
	function sleep(ms) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	// Fetch with retry on 429/5xx or network errors
	async function fetchWithRetry(url, options, retries = MAX_RETRIES) {
		for (let attempt = 0; attempt <= retries; attempt++) {
			try {
				const resp = await fetch(url, options);
				if (resp.ok) return resp;

				// Retry on rate limit or server errors
				if ((resp.status === 429 || resp.status >= 500) && attempt < retries) {
					const delay = DELETE_DELAY_MS * Math.pow(2, attempt);
					console.warn(
						`[ChatGPT Cleanup] HTTP ${resp.status} on ${url}, retrying in ${delay}ms (attempt ${attempt + 1}/${retries})`,
					);
					await sleep(delay);
					continue;
				}

				// Non-retryable error or exhausted retries
				throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
			} catch (err) {
				if (attempt < retries) {
					const delay = DELETE_DELAY_MS * Math.pow(2, attempt);
					console.warn(
						`[ChatGPT Cleanup] Network error on ${url}: ${err.message}, retrying in ${delay}ms`,
					);
					await sleep(delay);
				} else {
					throw err;
				}
			}
		}
	}

	// Get access token via session endpoint
	async function getAccessToken() {
		const resp = await fetchWithRetry("/api/auth/session", {
			credentials: "include",
			headers: { Accept: "application/json" },
		});
		const data = await resp.json();
		if (!data || !data.accessToken) {
			throw new Error("Could not retrieve access token. Are you logged in?");
		}
		return data.accessToken;
	}

	// Fetch all conversations (paginated), optionally including archived
	async function fetchAllConversations(token) {
		const allConvos = [];
		const baseUrl = "/backend-api/conversations";

		// Helper to fetch one "stream" (normal or archived)
		async function fetchStream(isArchived) {
			let offset = 0;
			let hasMore = true;

			while (hasMore) {
				let url = `${baseUrl}?offset=${offset}&limit=${PAGE_LIMIT}&order=updated`;
				if (isArchived) {
					url += "&is_archived=true";
				}

				const resp = await fetchWithRetry(url, {
					credentials: "include",
					headers: {
						Authorization: `Bearer ${token}`,
						Accept: "application/json",
					},
				});

				const data = await resp.json();

				if (!data || !Array.isArray(data.items)) {
					if (isArchived) {
						console.warn(
							"[ChatGPT Cleanup] Archived conversations endpoint returned unexpected data, skipping archived.",
						);
					}
					break;
				}

				allConvos.push(...data.items);

				hasMore = data.has_more === true && data.items.length > 0;
				offset += data.items.length;

				// Early exit optimization: if filtering by update_time and oldest item on page
				// is already newer than cutoff, we still need to continue (sorted desc by updated)
				// But if all items are newer than cutoff (not possible here since we want older ones),
				// we could theoretically break. However, since we want OLDER than cutoff, we keep fetching
				// until we hit items older than cutoff or run out.
				// Actually, since order=updated (desc), once we see items older than cutoff
				// we still must fetch the rest. But we can break if ALL items on current page are NEWER
				// than cutoff... wait, we want items OLDER than cutoff so we need everything.
				// No optimization possible here without knowing where the cutoff is in the sorted list.
			}
		}

		await fetchStream(false);

		if (INCLUDE_ARCHIVED) {
			try {
				await fetchStream(true);
			} catch (err) {
				console.warn(
					"[ChatGPT Cleanup] Failed to fetch archived conversations:",
					err.message,
				);
			}
		}

		return allConvos;
	}

	// Filter conversations older than cutoff
	function filterOldConversations(conversations) {
		const cutoff = getCutoffDate();
		const results = [];

		for (const convo of conversations) {
			const timeField = USE_UPDATE_TIME ? "update_time" : "create_time";
			const fallbackField = USE_UPDATE_TIME ? "create_time" : "update_time";

			let timestamp = convo[timeField];
			let usedField = timeField;

			// Fallback if primary field is missing
			if (timestamp == null) {
				timestamp = convo[fallbackField];
				usedField = fallbackField;
			}

			if (timestamp == null) continue;

			const convoDate = new Date(
				typeof timestamp === "number" ? timestamp * 1000 : timestamp,
			);

			if (convoDate < cutoff) {
				results.push({
					id: convo.id,
					title: convo.title || "(no title)",
					date: convoDate.toISOString(),
					usedField: usedField,
					raw: timestamp,
				});
			}
		}

		return results;
	}

	// Soft-delete a conversation via PATCH
	async function deleteConversation(token, id) {
		const url = `/backend-api/conversation/${id}`;
		await fetchWithRetry(url, {
			method: "PATCH",
			credentials: "include",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({ is_visible: false }),
		});
	}

	// Update button text safely
	function setButtonText(text) {
		const btn = document.getElementById(BUTTON_ID);
		if (btn) btn.textContent = text;
	}

	// Main execution logic
	async function run() {
		if (isRunning) return;
		isRunning = true;

		const btn = document.getElementById(BUTTON_ID);
		if (btn) {
			btn.disabled = true;
			btn.style.opacity = "0.7";
			btn.style.cursor = "wait";
		}

		try {
			setButtonText("🔑 Getting session...");
			const token = await getAccessToken();

			setButtonText("📥 Fetching conversations...");
			const allConversations = await fetchAllConversations(token);

			setButtonText("🔍 Filtering...");
			const candidates = filterOldConversations(allConversations);

			const cutoff = getCutoffDate();
			const timeMode = USE_UPDATE_TIME ? "update_time" : "create_time";
			console.log(`[ChatGPT Cleanup] Cutoff date: ${cutoff.toLocaleString()}`);
			console.log(`[ChatGPT Cleanup] Time mode: ${timeMode}`);
			console.log(
				`[ChatGPT Cleanup] Total fetched: ${allConversations.length}`,
			);
			console.log(
				`[ChatGPT Cleanup] Candidates to delete: ${candidates.length}`,
			);

			if (candidates.length > 0) {
				console.table(
					candidates.map((c) => ({
						id: c.id,
						title: c.title.substring(0, 60),
						date: c.date,
						usedField: c.usedField,
					})),
				);
			}

			if (DRY_RUN) {
				const msg = `[DRY RUN] Would delete ${candidates.length} conversation(s) older than 5 months.\nSee console for details. Set DRY_RUN = false to actually delete.`;
				alert(msg);
				setButtonText(
					`🗑️ Delete chats >5mo (${candidates.length} found, DRY RUN)`,
				);
				console.log(
					`[ChatGPT Cleanup] DRY RUN complete. ${candidates.length} conversations would be deleted.`,
				);
				return;
			}

			if (candidates.length === 0) {
				alert("No conversations older than 5 months found.");
				setButtonText("🗑️ Delete chats older than 5 months");
				return;
			}

			// Confirm before deleting
			const confirmed = confirm(
				`⚠️ You are about to DELETE ${candidates.length} conversation(s) older than 5 months.\n\n` +
					`This is IRREVERSIBLE. ChatGPT will soft-delete them (set invisible).\n\n` +
					`Click OK to confirm deletion, or Cancel to abort.`,
			);

			if (!confirmed) {
				alert("Deletion cancelled.");
				setButtonText("🗑️ Delete chats older than 5 months");
				return;
			}

			// Perform deletions
			let succeeded = 0;
			let failed = 0;
			const total = candidates.length;

			for (let i = 0; i < candidates.length; i++) {
				const candidate = candidates[i];
				setButtonText(`🗑️ Deleting ${i + 1}/${total}...`);

				try {
					await deleteConversation(token, candidate.id);
					succeeded++;
					console.log(
						`[ChatGPT Cleanup] Deleted [${i + 1}/${total}]: "${candidate.title}" (${candidate.id})`,
					);
				} catch (err) {
					failed++;
					console.error(
						`[ChatGPT Cleanup] Failed to delete "${candidate.title}" (${candidate.id}):`,
						err.message,
					);
				}

				// Rate limiting delay (skip on last item)
				if (i < candidates.length - 1) {
					await sleep(DELETE_DELAY_MS);
				}
			}

			const summary = `✅ Deletion complete!\n\nSucceeded: ${succeeded}\nFailed: ${failed}\nTotal: ${total}\n\nPlease refresh the page to see updated chat list.`;
			alert(summary);
			console.log(
				`[ChatGPT Cleanup] Done. Succeeded: ${succeeded}, Failed: ${failed}`,
			);
			setButtonText(`✅ Done (${succeeded}/${total} deleted)`);
		} catch (err) {
			console.error("[ChatGPT Cleanup] Error:", err);
			alert(`Error: ${err.message}\n\nCheck console for details.`);
			setButtonText("🗑️ Delete chats older than 5 months");
		} finally {
			isRunning = false;
			const btn = document.getElementById(BUTTON_ID);
			if (btn) {
				btn.disabled = false;
				btn.style.opacity = "1";
				btn.style.cursor = "pointer";
			}
		}
	}

	// Create and inject the button
	function injectButton() {
		if (document.getElementById(BUTTON_ID)) return;

		const btn = document.createElement("button");
		btn.id = BUTTON_ID;
		btn.textContent = DRY_RUN
			? "🗑️ Delete chats older than 5 months (DRY RUN)"
			: "🗑️ Delete chats older than 5 months";

		const cutoff = getCutoffDate();
		btn.title = [
			`Cutoff: ${cutoff.toLocaleDateString()}`,
			`Time filter: ${USE_UPDATE_TIME ? "update_time" : "create_time"}`,
			`Mode: ${DRY_RUN ? "DRY RUN (no actual deletes)" : "LIVE (will delete!)"}`,
			`Archived: ${INCLUDE_ARCHIVED ? "included" : "excluded"}`,
			`Click to run - check console for details`,
		].join("\n");

		Object.assign(btn.style, {
			position: "fixed",
			top: "12px",
			right: "12px",
			zIndex: "99999",
			padding: "8px 14px",
			fontSize: "13px",
			fontWeight: "600",
			fontFamily: "system-ui, sans-serif",
			backgroundColor: DRY_RUN ? "#2563eb" : "#dc2626",
			color: "#ffffff",
			border: "none",
			borderRadius: "8px",
			cursor: "pointer",
			boxShadow: "0 2px 12px rgba(0,0,0,0.25)",
			transition: "opacity 0.2s",
			maxWidth: "320px",
			lineHeight: "1.3",
			textAlign: "center",
		});

		btn.addEventListener("mouseenter", () => {
			if (!isRunning) btn.style.opacity = "0.85";
		});
		btn.addEventListener("mouseleave", () => {
			if (!isRunning) btn.style.opacity = "1";
		});

		btn.addEventListener("click", run);
		document.body.appendChild(btn);
		console.log(
			"[ChatGPT Cleanup] Button injected. DRY_RUN =",
			DRY_RUN,
			"| USE_UPDATE_TIME =",
			USE_UPDATE_TIME,
		);
	}

	// Ensure button persists across SPA navigation
	function ensureButton() {
		if (!document.getElementById(BUTTON_ID) && document.body) {
			injectButton();
		}
	}

	// Initial injection
	if (document.body) {
		injectButton();
	} else {
		document.addEventListener("DOMContentLoaded", injectButton);
	}

	// MutationObserver for SPA navigation (ChatGPT replaces DOM on navigation)
	const observer = new MutationObserver(() => {
		ensureButton();
	});

	observer.observe(document.documentElement, {
		childList: true,
		subtree: true,
	});

	// Fallback interval in case MutationObserver misses something
	setInterval(ensureButton, 3000);
})();
