// ==UserScript==
// @name         ChatGPT Delete Chats Older Than x Months
// @namespace    https://chatgpt.com/
// @version      1.2.3
// @description  Soft-delete ChatGPT conversations older than x months via backend API.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @homepageURL  https://gist.github.com/bruvv/c25a168271f7bda197b9a0422fdb80aa
// @supportURL   https://gist.github.com/bruvv/c25a168271f7bda197b9a0422fdb80aa
// @updateURL    https://gist.github.com/bruvv/c25a168271f7bda197b9a0422fdb80aa/raw/02e483a9b6360b2ce80d68ffa4637b808e58dc3c/chatgpt-delete-old-chats.user.js
// @downloadURL  https://gist.github.com/bruvv/c25a168271f7bda197b9a0422fdb80aa/raw/02e483a9b6360b2ce80d68ffa4637b808e58dc3c/chatgpt-delete-old-chats.user.js
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
	"use strict";

	// -----------------------------
	// Config
	// -----------------------------
	const DEFAULT_CONFIG = Object.freeze({
		dryRun: true,
		useUpdateTime: true,
		includeArchived: false,
		timeframeMonths: 5,
		pageLimit: 100,
		maxPagesPerPass: 1000,
		debugDeleteLimit: null,
	});
	const DELETE_DELAY_MS = 250;
	const MAX_RETRIES = 3;
	const RETRY_BACKOFF_MS = [250, 500, 1000];

	const BUTTON_ID = "tm-delete-old-chatgpt-chats-btn";
	const BUTTON_TEXT_RUNNING_PREFIX = "Deleting";
	const TOOLTIP_DEFAULT = "Preview count: not computed yet";
	const SETTINGS_PANEL_ID = "tm-delete-old-chatgpt-settings-panel";
	const SETTINGS_STORAGE_KEY = "tm_delete_old_chats_settings_v1";
	const UI_STYLE_ID = "tm-delete-old-chatgpt-styles";

	const BOOTSTRAP_FLAG = "__tm_delete_old_chats_bootstrapped__";
	const LOG_PREFIX = "[DeleteOldChats]";

	let isRunning = false;
	let settings = loadSettings();
	let ensureScheduled = false;

	function sleep(ms) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	function monthLabel(months) {
		return `${months} month${months === 1 ? "" : "s"}`;
	}

	function getButtonIdleText() {
		return `Delete chats older than ${monthLabel(settings.timeframeMonths)}`;
	}

	function normalizePositiveInt(value, fallback, minValue = 1) {
		const num = Number(value);
		if (!Number.isFinite(num)) {
			return fallback;
		}
		const intVal = Math.floor(num);
		if (intVal < minValue) {
			return fallback;
		}
		return intVal;
	}

	function normalizeSettings(input) {
		const raw = input && typeof input === "object" ? input : {};
		const next = {
			dryRun: typeof raw.dryRun === "boolean" ? raw.dryRun : DEFAULT_CONFIG.dryRun,
			useUpdateTime:
				typeof raw.useUpdateTime === "boolean"
					? raw.useUpdateTime
					: DEFAULT_CONFIG.useUpdateTime,
			includeArchived:
				typeof raw.includeArchived === "boolean"
					? raw.includeArchived
					: DEFAULT_CONFIG.includeArchived,
			timeframeMonths: normalizePositiveInt(
				raw.timeframeMonths,
				DEFAULT_CONFIG.timeframeMonths,
				1,
			),
			pageLimit: normalizePositiveInt(raw.pageLimit, DEFAULT_CONFIG.pageLimit, 1),
			maxPagesPerPass: normalizePositiveInt(
				raw.maxPagesPerPass,
				DEFAULT_CONFIG.maxPagesPerPass,
				1,
			),
			debugDeleteLimit: null,
		};

		if (
			raw.debugDeleteLimit === null ||
			raw.debugDeleteLimit === undefined ||
			raw.debugDeleteLimit === ""
		) {
			next.debugDeleteLimit = null;
		} else {
			const parsedLimit = normalizePositiveInt(raw.debugDeleteLimit, null, 1);
			next.debugDeleteLimit = parsedLimit;
		}

		return next;
	}

	function loadSettings() {
		try {
			const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
			if (!raw) {
				return normalizeSettings(DEFAULT_CONFIG);
			}
			return normalizeSettings(JSON.parse(raw));
		} catch (_err) {
			return normalizeSettings(DEFAULT_CONFIG);
		}
	}

	function persistSettings() {
		try {
			localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
		} catch (_err) {
			console.warn(`${LOG_PREFIX} Could not persist settings to localStorage.`);
		}
	}

	function applySettings(nextSettings) {
		settings = normalizeSettings(nextSettings);
		persistSettings();
		refreshMainButtonLabel();
	}

	function refreshMainButtonLabel() {
		const button = document.getElementById(BUTTON_ID);
		if (button && !isRunning) {
			const nextText = getButtonIdleText();
			if (button.textContent !== nextText) {
				button.textContent = nextText;
			}
		}
	}

	function createHttpError(message, status) {
		const err = new Error(message);
		err.status = status;
		return err;
	}

	function isRetryableError(err) {
		const status = err && typeof err.status === "number" ? err.status : null;
		if (err && err.isNetworkError) {
			return true;
		}
		if (status === 429) {
			return true;
		}
		return status !== null && status >= 500 && status <= 599;
	}

	function normalizeUnixSeconds(value) {
		if (value === null || value === undefined) {
			return null;
		}

		if (typeof value === "number") {
			if (!Number.isFinite(value) || value <= 0) {
				return null;
			}
			// Heuristic: if milliseconds slipped in, convert to seconds.
			return value > 1e12 ? Math.floor(value / 1000) : value;
		}

		if (typeof value === "string") {
			const trimmed = value.trim();
			if (!trimmed) {
				return null;
			}

			// Numeric timestamp string (seconds or milliseconds).
			if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
				const num = Number(trimmed);
				if (!Number.isFinite(num) || num <= 0) {
					return null;
				}
				return num > 1e12 ? Math.floor(num / 1000) : num;
			}

			// ISO/date string fallback.
			const parsedMs = Date.parse(trimmed);
			if (!Number.isFinite(parsedMs) || parsedMs <= 0) {
				return null;
			}
			return Math.floor(parsedMs / 1000);
		}

		return null;
	}

	function extractTimestamp(convo, baseField) {
		const aliases =
			baseField === "update_time"
				? [
						"update_time",
						"updated_time",
						"updateTime",
						"updatedAt",
						"updated_at",
						"last_update_time",
						"lastUpdatedAt",
					]
				: [
						"create_time",
						"created_time",
						"createTime",
						"createdAt",
						"created_at",
						"conversation_create_time",
					];

		const containers = [convo];
		if (convo && typeof convo.conversation === "object" && convo.conversation) {
			containers.push(convo.conversation);
		}

		for (const container of containers) {
			for (const key of aliases) {
				if (!Object.prototype.hasOwnProperty.call(container, key)) {
					continue;
				}
				const ts = normalizeUnixSeconds(container[key]);
				if (ts !== null) {
					return {
						ts,
						field: container === convo ? key : `conversation.${key}`,
					};
				}
			}
		}

		return null;
	}

	function formatLocalDateFromUnixSeconds(tsSeconds) {
		return new Date(tsSeconds * 1000).toLocaleString();
	}

	async function getAccessToken() {
		let res;
		try {
			res = await fetch("/api/auth/session", {
				method: "GET",
				credentials: "include",
			});
		} catch (_err) {
			const err = new Error("Network error while fetching auth session.");
			err.isNetworkError = true;
			throw err;
		}

		if (!res.ok) {
			throw createHttpError(
				`Failed to fetch auth session (HTTP ${res.status}).`,
				res.status,
			);
		}

		let data;
		try {
			data = await res.json();
		} catch (_err) {
			throw new Error("Auth session response was not valid JSON.");
		}

		const token =
			data && typeof data.accessToken === "string" ? data.accessToken : "";
		if (!token) {
			throw new Error("Access token missing in /api/auth/session response.");
		}
		return token;
	}

	async function fetchConversationsPage({ offset, limit, isArchived }, token) {
		const params = new URLSearchParams({
			offset: String(offset),
			limit: String(limit),
			order: "updated",
		});
		if (isArchived === true) {
			params.set("is_archived", "true");
		}

		let res;
		try {
			res = await fetch(`/backend-api/conversations?${params.toString()}`, {
				method: "GET",
				credentials: "include",
				headers: {
					Authorization: `Bearer ${token}`,
				},
			});
		} catch (_err) {
			const err = new Error("Network error while fetching conversations.");
			err.isNetworkError = true;
			throw err;
		}

		if (!res.ok) {
			throw createHttpError(
				`Failed to fetch conversations (HTTP ${res.status}).`,
				res.status,
			);
		}

		let data;
		try {
			data = await res.json();
		} catch (_err) {
			throw new Error("Conversations response was not valid JSON.");
		}

		let items = [];
		// Null means "unknown" (API did not include a pagination flag).
		let hasMore = null;

		if (Array.isArray(data)) {
			items = data;
			hasMore = false;
		} else if (data && typeof data === "object") {
			if (Array.isArray(data.items)) {
				items = data.items;
			} else if (Array.isArray(data.conversations)) {
				items = data.conversations;
			}
			if (typeof data.has_more === "boolean") {
				hasMore = data.has_more;
			} else if (typeof data.hasMore === "boolean") {
				hasMore = data.hasMore;
			}
		}

		return { items, has_more: hasMore };
	}

	async function fetchConversationPass(token, isArchived) {
		const all = [];
		let offset = 0;
		let pageCount = 0;

		while (true) {
			pageCount += 1;
			if (pageCount > settings.maxPagesPerPass) {
				console.warn(
					`${LOG_PREFIX} Reached maxPagesPerPass=${settings.maxPagesPerPass}. Stopping pagination early as a safety guard.`,
				);
				break;
			}

			const page = await fetchConversationsPage(
				{ offset, limit: settings.pageLimit, isArchived },
				token,
			);
			const items = Array.isArray(page.items) ? page.items : [];

			if (items.length === 0) {
				break;
			}

			all.push(...items);

			offset += items.length > 0 ? items.length : settings.pageLimit;

			if (typeof page.has_more === "boolean") {
				if (page.has_more !== true) {
					break;
				}
				continue;
			}

			// Fallback when has_more is missing: keep paging while page is "full".
			if (items.length < settings.pageLimit) {
				break;
			}
		}

		return all;
	}

	async function fetchAllConversations(token, includeArchived) {
		const byId = new Map();
		const standard = await fetchConversationPass(token, false);
		for (const item of standard) {
			if (item && item.id) {
				byId.set(item.id, item);
			}
		}

		if (includeArchived) {
			try {
				const archived = await fetchConversationPass(token, true);
				for (const item of archived) {
					if (item && item.id && !byId.has(item.id)) {
						byId.set(item.id, item);
					}
				}
			} catch (err) {
				const status =
					err && typeof err.status === "number"
						? `HTTP ${err.status}`
						: "unknown error";
				console.warn(
					`${LOG_PREFIX} Unable to fetch archived conversations (${status}). Continuing without archived chats.`,
				);
			}
		}

		return Array.from(byId.values());
	}

	function buildCandidates(conversations, cutoffDate, useUpdateTime) {
		const cutoffTs = cutoffDate.getTime() / 1000;
		const primaryField = useUpdateTime ? "update_time" : "create_time";
		const fallbackField = useUpdateTime ? "create_time" : "update_time";
		const candidates = [];

		for (const convo of conversations) {
			if (!convo || !convo.id) {
				continue;
			}

			const primary = extractTimestamp(convo, primaryField);
			const fallback = extractTimestamp(convo, fallbackField);

			let selectedTs = primary ? primary.ts : null;
			let selectedField = primary ? primary.field : primaryField;

			if (selectedTs === null && fallback) {
				selectedTs = fallback.ts;
				selectedField = fallback.field;
			}

			if (selectedTs === null) {
				continue;
			}

			if (selectedTs < cutoffTs) {
				candidates.push({
					id: String(convo.id),
					title:
						typeof convo.title === "string" && convo.title.trim()
							? convo.title.trim()
							: "(untitled)",
					selectedField,
					selectedTs,
					selectedDate: formatLocalDateFromUnixSeconds(selectedTs),
				});
			}
		}

		return candidates;
	}

	async function softDeleteConversation(id, token) {
		let res;
		try {
			res = await fetch(`/backend-api/conversation/${encodeURIComponent(id)}`, {
				method: "PATCH",
				credentials: "include",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ is_visible: false }),
			});
		} catch (_err) {
			const err = new Error(`Network error while deleting conversation ${id}.`);
			err.isNetworkError = true;
			throw err;
		}

		if (!res.ok) {
			throw createHttpError(
				`Delete failed for conversation ${id} (HTTP ${res.status}).`,
				res.status,
			);
		}
	}

	async function softDeleteWithRetry(id, token) {
		let lastError = null;
		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			try {
				await softDeleteConversation(id, token);
				return;
			} catch (err) {
				lastError = err;
				const retryable = isRetryableError(err);
				if (!retryable || attempt === MAX_RETRIES) {
					throw err;
				}

				const waitMs =
					RETRY_BACKOFF_MS[attempt] ??
					RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1] ??
					DELETE_DELAY_MS;

				const status =
					err && typeof err.status === "number" ? err.status : "network";
				console.warn(
					`${LOG_PREFIX} Retry ${attempt + 1}/${MAX_RETRIES} for ${id} after ${status}; waiting ${waitMs}ms.`,
				);
				await sleep(waitMs);
			}
		}

		if (lastError) {
			throw lastError;
		}
	}

	function setButtonState(button, { disabled, text, title }) {
		if (!button) return;
		if (typeof disabled === "boolean") {
			button.disabled = disabled;
			button.style.opacity = disabled ? "0.8" : "1";
			button.style.cursor = disabled ? "not-allowed" : "pointer";
		}
		if (typeof text === "string") {
			button.textContent = text;
		}
		if (typeof title === "string") {
			button.title = title;
		}
	}

	function ensureUiStyles() {
		if (document.getElementById(UI_STYLE_ID)) {
			return;
		}

		const style = document.createElement("style");
		style.id = UI_STYLE_ID;
		style.textContent = `
      #${BUTTON_ID} {
        position: fixed;
        top: 16px;
        right: 16px;
        z-index: 2147483647;
        padding: 11px 16px;
        border: 1px solid rgba(148, 163, 184, 0.25);
        border-radius: 14px;
        background:
          linear-gradient(135deg, rgba(15, 23, 42, 0.95), rgba(2, 6, 23, 0.95)),
          radial-gradient(120% 140% at 20% 0%, rgba(59, 130, 246, 0.22), transparent 60%);
        color: #f8fafc;
        font: 700 14px/1.2 "Avenir Next", "Segoe UI", "Helvetica Neue", sans-serif;
        letter-spacing: 0.01em;
        box-shadow: 0 14px 34px rgba(2, 6, 23, 0.38);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        cursor: pointer;
        transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
      }

      #${BUTTON_ID}:not(:disabled):hover {
        transform: translateY(-1px);
        border-color: rgba(125, 211, 252, 0.35);
        box-shadow: 0 18px 34px rgba(2, 6, 23, 0.42);
      }

      #${SETTINGS_PANEL_ID} {
        position: fixed;
        top: 66px;
        right: 16px;
        z-index: 2147483647;
        width: min(420px, calc(100vw - 24px));
        border-radius: 16px;
        border: 1px solid rgba(148, 163, 184, 0.22);
        background:
          linear-gradient(140deg, rgba(15, 23, 42, 0.94), rgba(3, 7, 18, 0.95)),
          radial-gradient(120% 140% at 10% 0%, rgba(16, 185, 129, 0.14), transparent 62%);
        color: #e2e8f0;
        box-shadow: 0 20px 44px rgba(2, 6, 23, 0.44);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        overflow: hidden;
      }

      #${SETTINGS_PANEL_ID} > summary {
        list-style: none;
        cursor: pointer;
        user-select: none;
        padding: 12px 14px;
        font: 700 13px/1.2 "Avenir Next", "Segoe UI", "Helvetica Neue", sans-serif;
        letter-spacing: 0.01em;
        display: flex;
        align-items: center;
        justify-content: space-between;
      }

      #${SETTINGS_PANEL_ID} > summary::-webkit-details-marker {
        display: none;
      }

      #${SETTINGS_PANEL_ID} > summary::after {
        content: "▾";
        font-size: 12px;
        opacity: 0.8;
        transition: transform 0.2s ease;
      }

      #${SETTINGS_PANEL_ID}:not([open]) > summary::after {
        transform: rotate(-90deg);
      }

      #${SETTINGS_PANEL_ID} .tm-doc-summary-left {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      #${SETTINGS_PANEL_ID} .tm-doc-dot {
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: #22c55e;
        box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.18);
      }

      #${SETTINGS_PANEL_ID} .tm-doc-body {
        border-top: 1px solid rgba(148, 163, 184, 0.2);
        padding: 12px 14px 14px;
        display: grid;
        gap: 12px;
      }

      #${SETTINGS_PANEL_ID} .tm-doc-muted {
        margin: 0;
        color: rgba(203, 213, 225, 0.85);
        font: 500 11px/1.35 "Avenir Next", "Segoe UI", "Helvetica Neue", sans-serif;
      }

      #${SETTINGS_PANEL_ID} .tm-doc-toggles {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 8px;
      }

      #${SETTINGS_PANEL_ID} .tm-doc-toggle {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        border: 1px solid rgba(148, 163, 184, 0.24);
        background: rgba(15, 23, 42, 0.48);
        border-radius: 10px;
        padding: 8px 9px;
        font: 600 11px/1.2 "Avenir Next", "Segoe UI", "Helvetica Neue", sans-serif;
      }

      #${SETTINGS_PANEL_ID} .tm-doc-toggle input[type="checkbox"] {
        width: 16px;
        height: 16px;
        accent-color: #3b82f6;
        cursor: pointer;
      }

      #${SETTINGS_PANEL_ID} .tm-doc-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
      }

      #${SETTINGS_PANEL_ID} .tm-doc-field {
        display: grid;
        gap: 6px;
      }

      #${SETTINGS_PANEL_ID} .tm-doc-field.tm-doc-field-full {
        grid-column: 1 / -1;
      }

      #${SETTINGS_PANEL_ID} .tm-doc-field > span {
        color: #cbd5e1;
        font: 600 11px/1.2 "Avenir Next", "Segoe UI", "Helvetica Neue", sans-serif;
        letter-spacing: 0.01em;
      }

      #${SETTINGS_PANEL_ID} input[type="text"],
      #${SETTINGS_PANEL_ID} input[type="number"] {
        width: 100%;
        box-sizing: border-box;
        border-radius: 10px;
        border: 1px solid rgba(148, 163, 184, 0.28);
        background: rgba(15, 23, 42, 0.68);
        color: #f8fafc;
        padding: 8px 10px;
        font: 600 12px/1.2 "Avenir Next", "Segoe UI", "Helvetica Neue", sans-serif;
        outline: none;
        transition: border-color 0.16s ease, box-shadow 0.16s ease;
      }

      #${SETTINGS_PANEL_ID} input::placeholder {
        color: rgba(203, 213, 225, 0.56);
      }

      #${SETTINGS_PANEL_ID} input:focus {
        border-color: rgba(96, 165, 250, 0.85);
        box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.22);
      }

      #${SETTINGS_PANEL_ID} .tm-doc-actions {
        display: flex;
        gap: 8px;
      }

      #${SETTINGS_PANEL_ID} .tm-doc-btn {
        border-radius: 10px;
        border: 1px solid rgba(148, 163, 184, 0.24);
        padding: 8px 12px;
        cursor: pointer;
        color: #f8fafc;
        font: 700 12px/1.1 "Avenir Next", "Segoe UI", "Helvetica Neue", sans-serif;
      }

      #${SETTINGS_PANEL_ID} .tm-doc-btn-primary {
        background: linear-gradient(180deg, #2563eb, #1d4ed8);
      }

      #${SETTINGS_PANEL_ID} .tm-doc-btn-secondary {
        background: rgba(51, 65, 85, 0.72);
      }

      #${SETTINGS_PANEL_ID} .tm-doc-btn:hover {
        filter: brightness(1.07);
      }

      @media (max-width: 720px) {
        #${BUTTON_ID} {
          top: 10px;
          right: 10px;
          left: 10px;
          width: auto;
        }

        #${SETTINGS_PANEL_ID} {
          right: 10px;
          left: 10px;
          width: auto;
          top: 58px;
        }

        #${SETTINGS_PANEL_ID} .tm-doc-toggles {
          grid-template-columns: 1fr;
        }

        #${SETTINGS_PANEL_ID} .tm-doc-grid {
          grid-template-columns: 1fr;
        }
      }
    `;

		(document.head || document.documentElement).appendChild(style);
	}

	async function runCleanup(button) {
		if (isRunning) {
			return;
		}
		isRunning = true;

		setButtonState(button, {
			disabled: true,
			text: "Preparing...",
		});

		try {
			if (
				!Number.isFinite(settings.timeframeMonths) ||
				settings.timeframeMonths <= 0
			) {
				throw new Error("timeframeMonths must be a number greater than 0.");
			}

			const token = await getAccessToken();
			const conversations = await fetchAllConversations(
				token,
				settings.includeArchived,
			);

			const cutoff = new Date();
			cutoff.setMonth(cutoff.getMonth() - settings.timeframeMonths);

			const candidates = buildCandidates(
				conversations,
				cutoff,
				settings.useUpdateTime,
			);
			const altCandidates = buildCandidates(
				conversations,
				cutoff,
				!settings.useUpdateTime,
			);
			const hasDebugLimit =
				Number.isInteger(settings.debugDeleteLimit) &&
				settings.debugDeleteLimit > 0;
			const deleteCandidates = hasDebugLimit
				? candidates.slice(0, settings.debugDeleteLimit)
				: candidates;
			const modeLabel = settings.useUpdateTime ? "update_time" : "create_time";

			console.info(
				`${LOG_PREFIX} Total conversations scanned: ${conversations.length}. Candidates older than ${monthLabel(settings.timeframeMonths)} (${modeLabel}): ${candidates.length}.`,
			);
			if (hasDebugLimit) {
				console.info(
					`${LOG_PREFIX} DEBUG_DELETE_LIMIT active: deleting only ${deleteCandidates.length}/${candidates.length} candidate(s).`,
				);
			}
			if (candidates.length === 0 && altCandidates.length > 0) {
				const suggestedField = settings.useUpdateTime
					? "create_time"
					: "update_time";
				console.warn(
					`${LOG_PREFIX} No matches with current time field mode, but ${altCandidates.length} match(es) exist using ${suggestedField}. Consider toggling useUpdateTime in settings.`,
				);
			}
			console.table(
				candidates.map((c) => ({
					id: c.id,
					title: c.title,
					date: c.selectedDate,
					time_field_used: c.selectedField,
				})),
			);

			setButtonState(button, {
				title: `Preview count: ${candidates.length}`,
			});

			if (settings.dryRun) {
				alert(
					[
						`DRY RUN: ${candidates.length} chats older than ${monthLabel(settings.timeframeMonths)} would be soft-deleted.`,
						`Scanned: ${conversations.length} chats.`,
						hasDebugLimit
							? `DEBUG_DELETE_LIMIT is active: only ${deleteCandidates.length} chat(s) would actually be processed.`
							: "No delete limit override is active.",
						"No deletions were executed.",
						"Disable Dry Run in settings to perform deletion.",
					].join("\n"),
				);
				return;
			}

			if (deleteCandidates.length === 0) {
				alert("No chats matched the cutoff. Nothing to delete.");
				return;
			}

			const confirmed = confirm(
				[
					`About to soft-delete ${deleteCandidates.length} conversation(s).`,
					`Timeframe: older than ${monthLabel(settings.timeframeMonths)}.`,
					`Scanned total: ${conversations.length}.`,
					`Total candidates before limit: ${candidates.length}.`,
					hasDebugLimit
						? `DEBUG_DELETE_LIMIT: ${settings.debugDeleteLimit}.`
						: "DEBUG_DELETE_LIMIT: disabled.",
					`Time filter mode: ${modeLabel} (with fallback if missing).`,
					'Action: PATCH /backend-api/conversation/{id} with {"is_visible": false}.',
					"",
					"Do you want to continue?",
				].join("\n"),
			);
			if (!confirmed) {
				return;
			}

			let successCount = 0;
			let failureCount = 0;
			const total = deleteCandidates.length;

			for (let i = 0; i < total; i++) {
				const c = deleteCandidates[i];
				setButtonState(button, {
					text: `${BUTTON_TEXT_RUNNING_PREFIX} ${i + 1}/${total}`,
					disabled: true,
				});

				try {
					await softDeleteWithRetry(c.id, token);
					successCount += 1;
				} catch (err) {
					failureCount += 1;
					const status =
						err && typeof err.status === "number"
							? `HTTP ${err.status}`
							: "network/unknown";
					console.warn(`${LOG_PREFIX} Failed to delete ${c.id}: ${status}`);
				}

				await sleep(DELETE_DELAY_MS);
			}

			alert(
				[
					"Delete run complete.",
					`Succeeded: ${successCount}`,
					`Failed: ${failureCount}`,
					"Refresh the page to see the updated chat list.",
				].join("\n"),
			);
		} catch (err) {
			const message = err && err.message ? err.message : "Unknown error.";
			console.error(`${LOG_PREFIX} ${message}`);
			alert(`Error: ${message}`);
		} finally {
			isRunning = false;
			setButtonState(button, {
				disabled: false,
				text: getButtonIdleText(),
			});
		}
	}

	function createButton() {
		const btn = document.createElement("button");
		btn.id = BUTTON_ID;
		btn.type = "button";
		btn.textContent = getButtonIdleText();
		btn.title = TOOLTIP_DEFAULT;

		btn.addEventListener("click", () => {
			void runCleanup(btn);
		});

		return btn;
	}

	function getPanelField(panel, fieldName) {
		return panel.querySelector(`[data-setting="${fieldName}"]`);
	}

	function setPanelValues(panel) {
		const dryRun = getPanelField(panel, "dryRun");
		const useUpdateTime = getPanelField(panel, "useUpdateTime");
		const includeArchived = getPanelField(panel, "includeArchived");
		const timeframeMonths = getPanelField(panel, "timeframeMonths");
		const pageLimit = getPanelField(panel, "pageLimit");
		const maxPagesPerPass = getPanelField(panel, "maxPagesPerPass");
		const debugDeleteLimit = getPanelField(panel, "debugDeleteLimit");

		if (dryRun) dryRun.checked = settings.dryRun;
		if (useUpdateTime) useUpdateTime.checked = settings.useUpdateTime;
		if (includeArchived) includeArchived.checked = settings.includeArchived;
		if (timeframeMonths) timeframeMonths.value = String(settings.timeframeMonths);
		if (pageLimit) pageLimit.value = String(settings.pageLimit);
		if (maxPagesPerPass) maxPagesPerPass.value = String(settings.maxPagesPerPass);
		if (debugDeleteLimit) {
			debugDeleteLimit.value =
				settings.debugDeleteLimit === null
					? ""
					: String(settings.debugDeleteLimit);
		}
	}

	function getPanelSettings(panel) {
		const dryRun = getPanelField(panel, "dryRun");
		const useUpdateTime = getPanelField(panel, "useUpdateTime");
		const includeArchived = getPanelField(panel, "includeArchived");
		const timeframeMonths = getPanelField(panel, "timeframeMonths");
		const pageLimit = getPanelField(panel, "pageLimit");
		const maxPagesPerPass = getPanelField(panel, "maxPagesPerPass");
		const debugDeleteLimit = getPanelField(panel, "debugDeleteLimit");

		const debugRaw = debugDeleteLimit ? String(debugDeleteLimit.value).trim() : "";

		return {
			dryRun: dryRun ? Boolean(dryRun.checked) : settings.dryRun,
			useUpdateTime: useUpdateTime
				? Boolean(useUpdateTime.checked)
				: settings.useUpdateTime,
			includeArchived: includeArchived
				? Boolean(includeArchived.checked)
				: settings.includeArchived,
			timeframeMonths: timeframeMonths
				? timeframeMonths.value
				: settings.timeframeMonths,
			pageLimit: pageLimit ? pageLimit.value : settings.pageLimit,
			maxPagesPerPass: maxPagesPerPass
				? maxPagesPerPass.value
				: settings.maxPagesPerPass,
			debugDeleteLimit: debugRaw === "" ? null : debugRaw,
		};
	}

	function createSettingsPanel() {
		const panel = document.createElement("details");
		panel.id = SETTINGS_PANEL_ID;
		panel.open = false;

		panel.innerHTML = `
      <summary>
        <span class="tm-doc-summary-left">
          <span class="tm-doc-dot"></span>
          <span>Delete Settings</span>
        </span>
      </summary>
      <div class="tm-doc-body">
        <p class="tm-doc-muted">Tweaks are stored only in your browser (localStorage).</p>

        <div class="tm-doc-toggles">
          <label class="tm-doc-toggle">
            <span>Dry run</span>
            <input data-setting="dryRun" type="checkbox">
          </label>
          <label class="tm-doc-toggle">
            <span>Use update_time</span>
            <input data-setting="useUpdateTime" type="checkbox">
          </label>
          <label class="tm-doc-toggle">
            <span>Include archived</span>
            <input data-setting="includeArchived" type="checkbox">
          </label>
        </div>

        <div class="tm-doc-grid">
          <label class="tm-doc-field">
            <span>Timeframe (months)</span>
            <input data-setting="timeframeMonths" type="number" min="1" step="1">
          </label>
          <label class="tm-doc-field">
            <span>Debug delete limit</span>
            <input data-setting="debugDeleteLimit" type="number" min="1" step="1" placeholder="blank = off">
          </label>
          <label class="tm-doc-field">
            <span>Page limit</span>
            <input data-setting="pageLimit" type="number" min="1" step="1">
          </label>
          <label class="tm-doc-field">
            <span>Max pages per pass</span>
            <input data-setting="maxPagesPerPass" type="number" min="1" step="1">
          </label>
        </div>

        <div class="tm-doc-actions">
          <button type="button" class="tm-doc-btn tm-doc-btn-primary" data-action="save">Save</button>
          <button type="button" class="tm-doc-btn tm-doc-btn-secondary" data-action="reset">Reset</button>
        </div>
      </div>
    `;

		const saveButton = panel.querySelector('[data-action="save"]');
		const resetButton = panel.querySelector('[data-action="reset"]');

		if (saveButton) {
			saveButton.addEventListener("click", () => {
				const panelSettings = getPanelSettings(panel);
				applySettings(panelSettings);
				setPanelValues(panel);
				console.info(`${LOG_PREFIX} Settings saved.`);
			});
		}

		if (resetButton) {
			resetButton.addEventListener("click", () => {
				applySettings(DEFAULT_CONFIG);
				setPanelValues(panel);
				console.info(`${LOG_PREFIX} Settings reset to defaults.`);
			});
		}

		setPanelValues(panel);
		return panel;
	}

	function ensureSettingsPanel() {
		if (!document.body) {
			return null;
		}

		let panel = document.getElementById(SETTINGS_PANEL_ID);
		if (!panel || !panel.isConnected) {
			panel = createSettingsPanel();
			document.body.appendChild(panel);
		}
		return panel;
	}

	function ensureButton() {
		if (!document.body) {
			return null;
		}

		let button = document.getElementById(BUTTON_ID);
		if (!button) {
			button = createButton();
			document.body.appendChild(button);
		} else if (!isRunning) {
			const nextText = getButtonIdleText();
			if (button.textContent !== nextText) {
				button.textContent = nextText;
			}
		}
		return button;
	}

	function scheduleEnsureUi() {
		if (ensureScheduled) {
			return;
		}
		ensureScheduled = true;
		setTimeout(() => {
			ensureScheduled = false;
			ensureButton();
			ensureSettingsPanel();
		}, 50);
	}

	function installSpaGuards() {
		ensureUiStyles();
		ensureButton();
		ensureSettingsPanel();

		// Interval fallback for route transitions where large DOM portions remount.
		setInterval(() => {
			ensureButton();
			ensureSettingsPanel();
		}, 2000);

		const root = document.documentElement || document.body;
		if (!root) {
			return;
		}

		const observer = new MutationObserver(() => {
			scheduleEnsureUi();
		});
		observer.observe(root, { childList: true, subtree: true });
	}

	if (window[BOOTSTRAP_FLAG]) {
		return;
	}
	window[BOOTSTRAP_FLAG] = true;

	installSpaGuards();
})();
