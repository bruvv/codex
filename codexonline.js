// ==UserScript==
// @name         ChatGPT Delete Chats Older Than 5 Months
// @namespace    https://chatgpt.com/
// @version      1.0.0
// @description  Deletes old ChatGPT chats via backend soft-delete API (is_visible=false), with dry-run preview and progress.
// @author       You
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(() => {
	"use strict";

	/********************************************************************
	 * Config
	 ********************************************************************/
	const DRY_RUN = true; // true = preview only (no deletes)
	const USE_UPDATE_TIME = true; // true=use update_time, false=use create_time
	const INCLUDE_ARCHIVED = false; // try fetching archived chats too
	const PAGE_LIMIT = 100;
	const DELETE_DELAY_MS = 250;
	const DELETE_RETRIES = 3;
	const BUTTON_ID = "tm-delete-old-chats-btn";

	let isRunning = false;

	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

	function formatDate(tsSeconds) {
		if (!tsSeconds || Number.isNaN(Number(tsSeconds))) return "(geen datum)";
		const d = new Date(Number(tsSeconds) * 1000);
		return `${d.toLocaleString()} (${d.toISOString()})`;
	}

	function getCutoffDate() {
		const cutoff = new Date();
		cutoff.setMonth(cutoff.getMonth() - 5); // local browser time as requested
		return cutoff;
	}

	async function getAccessToken() {
		const res = await fetch("/api/auth/session", {
			method: "GET",
			credentials: "include",
			headers: { Accept: "application/json" },
		});

		if (!res.ok) {
			throw new Error(`Kon sessie niet ophalen (${res.status})`);
		}

		const session = await res.json();
		const token = session?.accessToken;
		if (!token)
			throw new Error(
				"Geen access token gevonden in /api/auth/session response.",
			);
		return token;
	}

	async function fetchConversationPage(token, offset, limit, archived = false) {
		const params = new URLSearchParams({
			offset: String(offset),
			limit: String(limit),
			order: "updated",
		});

		if (archived) params.set("is_archived", "true");

		const res = await fetch(`/backend-api/conversations?${params.toString()}`, {
			method: "GET",
			credentials: "include",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${token}`,
			},
		});

		if (!res.ok) {
			throw new Error(
				`Conversations ophalen mislukt (${res.status}) [archived=${archived}]`,
			);
		}

		return res.json();
	}

	async function fetchAllConversations(token, archived = false) {
		const all = [];
		let offset = 0;

		while (true) {
			const data = await fetchConversationPage(
				token,
				offset,
				PAGE_LIMIT,
				archived,
			);
			const items = Array.isArray(data?.items) ? data.items : [];

			if (items.length === 0) break;

			all.push(...items);
			offset += items.length;

			if (!data?.has_more) break;
		}

		return all;
	}

	function selectCandidates(conversations) {
		const cutoff = getCutoffDate();
		const selected = [];

		for (const conv of conversations) {
			const id = conv?.id;
			if (!id) continue;

			const timeField = USE_UPDATE_TIME ? "update_time" : "create_time";
			const tsSeconds = conv?.[timeField];
			if (!tsSeconds) continue;

			const dt = new Date(Number(tsSeconds) * 1000);
			if (Number.isNaN(dt.getTime())) continue;

			if (dt < cutoff) {
				selected.push({
					id,
					title: conv?.title || "(zonder titel)",
					timestamp: Number(tsSeconds),
					date: dt,
					timeFieldUsed: timeField,
				});
			}
		}

		return { selected, cutoff };
	}

	async function patchDeleteConversation(token, id) {
		const res = await fetch(
			`/backend-api/conversation/${encodeURIComponent(id)}`,
			{
				method: "PATCH",
				credentials: "include",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${token}`,
					Accept: "application/json",
				},
				body: JSON.stringify({ is_visible: false }),
			},
		);

		if (!res.ok) {
			const err = new Error(`Delete mislukt (${res.status})`);
			err.status = res.status;
			throw err;
		}
	}

	async function deleteWithRetry(token, id) {
		let attempt = 0;
		let lastErr;

		while (attempt <= DELETE_RETRIES) {
			try {
				await patchDeleteConversation(token, id);
				return;
			} catch (err) {
				lastErr = err;
				const status = err?.status;
				const retryable =
					!status || status === 429 || (status >= 500 && status <= 599);
				if (!retryable || attempt === DELETE_RETRIES) break;

				const backoff = DELETE_DELAY_MS * 2 ** attempt; // 250, 500, 1000...
				console.warn(
					`Retry ${attempt + 1}/${DELETE_RETRIES} voor ${id} na ${backoff}ms (status=${status ?? "network"})`,
				);
				await sleep(backoff);
			}
			attempt += 1;
		}

		throw lastErr;
	}

	function getOrCreateButton() {
		let btn = document.getElementById(BUTTON_ID);
		if (btn) return btn;

		btn = document.createElement("button");
		btn.id = BUTTON_ID;
		btn.type = "button";
		btn.textContent = "Delete chats older than 5 months";
		btn.title = "Preview count: klik om te scannen";

		Object.assign(btn.style, {
			position: "fixed",
			top: "12px",
			right: "12px",
			zIndex: "999999",
			padding: "10px 14px",
			borderRadius: "10px",
			border: "1px solid rgba(255,255,255,0.25)",
			background: "#d73a49",
			color: "#fff",
			fontSize: "13px",
			fontWeight: "600",
			cursor: "pointer",
			boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
			opacity: "0.95",
		});

		btn.addEventListener("mouseenter", () => {
			btn.style.opacity = "1";
		});
		btn.addEventListener("mouseleave", () => {
			btn.style.opacity = "0.95";
		});

		btn.addEventListener("click", async () => {
			if (isRunning) return;
			isRunning = true;

			const originalText = "Delete chats older than 5 months";
			btn.disabled = true;
			btn.style.cursor = "not-allowed";

			try {
				btn.textContent = "Fetching token...";
				const token = await getAccessToken();

				btn.textContent = "Loading conversations...";
				const normalConversations = await fetchAllConversations(token, false);

				let allConversations = [...normalConversations];

				if (INCLUDE_ARCHIVED) {
					try {
						const archivedConversations = await fetchAllConversations(
							token,
							true,
						);
						const seen = new Set(allConversations.map((c) => c?.id));
						for (const c of archivedConversations) {
							if (c?.id && !seen.has(c.id)) {
								seen.add(c.id);
								allConversations.push(c);
							}
						}
					} catch (archivedErr) {
						console.warn(
							"INCLUDE_ARCHIVED=true maar archived ophalen is mislukt. Doorgaan met niet-archived.",
							archivedErr,
						);
					}
				}

				const { selected, cutoff } = selectCandidates(allConversations);
				const previewRows = selected.map((c) => ({
					id: c.id,
					title: c.title,
					datum: formatDate(c.timestamp),
					used_time_field: c.timeFieldUsed,
				}));

				console.log(`Cutoff (local time): ${cutoff.toString()}`);
				console.log(
					`Totaal geladen: ${allConversations.length}, kandidaten: ${selected.length}`,
				);
				if (previewRows.length) console.table(previewRows);

				btn.title = `Preview count: ${selected.length} candidate chats`;

				if (DRY_RUN) {
					alert(
						`DRY RUN\n\n${selected.length} chats zouden verwijderd worden (soft delete: is_visible=false).\n\nZie console voor details.`,
					);
					return;
				}

				const ok = window.confirm(
					`Je staat op het punt ${selected.length} chats te verwijderen (soft delete) die ouder zijn dan 5 maanden.\n\n` +
						`Filter: ${USE_UPDATE_TIME ? "update_time" : "create_time"}\n` +
						`Cutoff: ${cutoff.toString()}\n\n` +
						"Doorgaan?",
				);

				if (!ok) return;

				let success = 0;
				let failed = 0;

				for (let i = 0; i < selected.length; i += 1) {
					const item = selected[i];
					btn.textContent = `Deleting ${i + 1}/${selected.length}`;

					try {
						await deleteWithRetry(token, item.id);
						success += 1;
					} catch (err) {
						failed += 1;
						console.error(`Delete mislukt voor ${item.id}`, err);
					}

					if (i < selected.length - 1) await sleep(DELETE_DELAY_MS);
				}

				alert(
					`Klaar.\n\nGelukt: ${success}\nMislukt: ${failed}\nTotaal: ${selected.length}\n\n` +
						"Advies: refresh de pagina om de geüpdatete chatlijst te zien.",
				);
			} catch (err) {
				console.error("Script error:", err);
				alert(`Fout: ${err?.message || err}`);
			} finally {
				btn.disabled = false;
				btn.textContent = originalText;
				btn.style.cursor = "pointer";
				isRunning = false;
			}
		});

		document.body.appendChild(btn);
		return btn;
	}

	function ensureButton() {
		if (!document.body) return;
		getOrCreateButton();
	}

	// SPA robustness: ensure button survives route/layout updates.
	const observer = new MutationObserver(() => {
		ensureButton();
	});

	function init() {
		ensureButton();
		if (document.body) {
			observer.observe(document.body, { childList: true, subtree: true });
		}
		setInterval(ensureButton, 2000);
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", init, { once: true });
	} else {
		init();
	}
})();
