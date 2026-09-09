const FIXR_URL = "https://fixr.co/organiser/timepiece?lang=en-US";
const STATE_KEY = "last_seen_events";

const WHATSAPP_API_VERSION = "v26.0";

// Keep using the currently approved template for now.
const WHATSAPP_TEMPLATE_NAME = "fixr_event_alert2";
const WHATSAPP_TEMPLATE_LANGUAGE = "en";
const TEMPLATE_ACCEPTS_EVENT_DETAILS = true;

const MONITORING_START_MINUTES = 7 * 60 + 50;
const MONITORING_END_MINUTES = 24 * 60;

export default {
	async fetch(request, env) {
	const url = new URL(request.url);

	if (url.pathname === "/test-whatsapp") {
		if (request.method !== "GET") {
			return new Response("Not found", { status: 404 });
		}

		try {
			const recipients = getWhatsAppRecipients(env);
			const failures = [];
			let succeeded = 0;

			for (let index = 0; index < recipients.length; index += 1) {
				try {
					await sendWhatsAppAlert(env, recipients[index], {
						name: "Wednesday 15.07",
						url: "https://fixr.co/event/wednesday-1507-tickets-661837135",
					});
					succeeded += 1;
				} catch (error) {
					failures.push({
						recipient_index: index + 1,
						error: error.message,
					});
				}
			}

			return Response.json({
				attempted: recipients.length,
				succeeded,
				failures,
			});
		} catch (error) {
			return Response.json(
				{
					attempted: 0,
					succeeded: 0,
					failures: [{ error: error.message }],
				},
				{ status: 500 },
			);
		}
	}

	if (url.pathname === "/health") {
		return Response.json({
			success: true,
			status: "worker_online",
			checked_at: new Date().toISOString(),
			currently_in_window: isWithinMonitoringWindow(),
		});
	}

	try {
		const result = await checkForEvents(env);

		return Response.json({
			...result,
			monitoring_window: "07:50-00:00 Europe/London",
			currently_in_window: isWithinMonitoringWindow(),
		});
	} catch (error) {
		return Response.json(
			{
				success: false,
				error: error.message,
			},
			{ status: 500 },
		);
	}
},
	async scheduled(controller, env, ctx) {
		ctx.waitUntil(runScheduledCheck(env));
	},
};

async function runScheduledCheck(env) {
	if (!isWithinMonitoringWindow()) {
		console.log("Skipped FIXR check: outside UK monitoring window.");
		await reportHeartbeat(env, false);
		return;
	}

	try {
		const result = await checkForEvents(env);

		if (!result.success) {
			console.error(
				"Scheduled check reported a failure:",
				JSON.stringify(result.failed_notifications),
			);

			await reportHeartbeat(env, true);
			return;
		}

		console.log(JSON.stringify(result));
		await reportHeartbeat(env, false);
	} catch (error) {
		console.error("Scheduled check failed:", error);
		await reportHeartbeat(env, true);
	}
}

async function reportHeartbeat(env, failed) {
	if (!env.BETTERSTACK_HEARTBEAT_URL) {
		console.error("Better Stack heartbeat secret is missing.");
		return;
	}

	const heartbeatUrl = String(
		env.BETTERSTACK_HEARTBEAT_URL,
	).replace(/\/+$/, "");

	const targetUrl = failed
		? `${heartbeatUrl}/fail`
		: heartbeatUrl;

	try {
		const response = await fetch(targetUrl);

		if (!response.ok) {
			console.error(
				`Better Stack returned status ${response.status}`,
			);
		}
	} catch (error) {
		console.error("Could not contact Better Stack:", error);
	}
}

async function checkForEvents(env) {
	const currentEventUrls = await getCurrentEventUrls();
	const savedState = await env.FIXR_STATE.get(STATE_KEY, "json");

	if (savedState === null) {
		await saveSeenState(env, currentEventUrls);

		return {
			success: true,
			status: "baseline_created",
			checked_at: new Date().toISOString(),
			event_count: currentEventUrls.length,
			notification_sent: false,
			notifications_sent: 0,
			new_events: [],
			events: currentEventUrls,
		};
	}

	const savedUrls = readSavedUrls(savedState);
	const seenUrls = new Set(savedUrls);
	const recipientDeliveries = readRecipientDeliveries(savedState);

	const newEventUrls = currentEventUrls.filter(
		(eventUrl) => !seenUrls.has(eventUrl),
	);

	const sentEvents = [];
	const failedNotifications = [];
	let notificationsSent = 0;
	let stateUpdated = false;
	let recipients = [];
	let recipientIds = [];
	let recipientConfigurationError = null;

	if (newEventUrls.length > 0) {
		try {
			recipients = getWhatsAppRecipients(env);
			recipientIds = await Promise.all(
				recipients.map(recipientStateId),
			);
		} catch (error) {
			recipientConfigurationError = error;
		}
	}

	for (const eventUrl of newEventUrls) {
		if (recipientConfigurationError) {
			failedNotifications.push({
				url: eventUrl,
				error: recipientConfigurationError.message,
			});
			continue;
		}

		try {
			const eventName = TEMPLATE_ACCEPTS_EVENT_DETAILS
				? await getEventName(eventUrl)
				: eventNameFromUrl(eventUrl);
			const deliveredRecipientIds =
				recipientDeliveries.get(eventUrl) || new Set();
			let eventNotificationSent = false;

			for (let index = 0; index < recipients.length; index += 1) {
				const recipientId = recipientIds[index];

				if (deliveredRecipientIds.has(recipientId)) {
					continue;
				}

				try {
					await sendWhatsAppAlert(env, recipients[index], {
						name: eventName,
						url: eventUrl,
					});

					deliveredRecipientIds.add(recipientId);
					notificationsSent += 1;
					eventNotificationSent = true;

					if (
						recipientIds.every((id) =>
							deliveredRecipientIds.has(id),
						)
					) {
						seenUrls.add(eventUrl);
						recipientDeliveries.delete(eventUrl);
					} else {
						recipientDeliveries.set(
							eventUrl,
							deliveredRecipientIds,
						);
					}

					await saveSeenState(
						env,
						[...seenUrls],
						recipientDeliveries,
					);
					stateUpdated = true;
				} catch (error) {
					failedNotifications.push({
						url: eventUrl,
						recipient_index: index + 1,
						error: error.message,
					});
				}
			}

			if (
				recipientIds.every((id) =>
					deliveredRecipientIds.has(id),
				) &&
				!seenUrls.has(eventUrl)
			) {
				seenUrls.add(eventUrl);
				recipientDeliveries.delete(eventUrl);
				await saveSeenState(
					env,
					[...seenUrls],
					recipientDeliveries,
				);
				stateUpdated = true;
			}

			if (eventNotificationSent) {
				sentEvents.push({
					name: eventName,
					url: eventUrl,
				});
			}
		} catch (error) {
			failedNotifications.push({
				url: eventUrl,
				error: error.message,
			});
		}
	}

	const needsMigration =
		!Array.isArray(savedState.seen_event_urls);

	if (needsMigration && !stateUpdated) {
		await saveSeenState(
			env,
			[...seenUrls],
			recipientDeliveries,
		);
		stateUpdated = true;
	}

	let status = "no_change";

	if (notificationsSent > 0) {
		status = "new_events_found";
	}

	if (failedNotifications.length > 0) {
		status =
			notificationsSent > 0
				? "partial_notification_failure"
				: "notification_failed";
	}

	return {
		success: failedNotifications.length === 0,
		status,
		checked_at: new Date().toISOString(),
		event_count: currentEventUrls.length,
		seen_event_count: seenUrls.size,
		state_updated: stateUpdated,
		notification_sent: notificationsSent > 0,
		notifications_sent: notificationsSent,
		new_events: sentEvents,
		failed_notifications: failedNotifications,
		events: currentEventUrls,
	};
}

async function getCurrentEventUrls() {
	const response = await fetch(FIXR_URL, {
		headers: {
			"User-Agent": "FIXR Event Monitor/1.0",
		},
	});

	if (!response.ok) {
		throw new Error(`FIXR returned status ${response.status}`);
	}

	const html = await response.text();
	return extractEventUrls(html);
}

function extractEventUrls(html) {
	const eventUrls = new Set();
	const pattern = /<[^>]*\shref\s*=\s*(["'])(.*?)\1[^>]*>/gi;

	for (const match of html.matchAll(pattern)) {
		let url;

		try {
			url = new URL(match[2], FIXR_URL);
		} catch {
			continue;
		}

		if (
			(url.hostname !== "fixr.co" &&
				url.hostname !== "www.fixr.co") ||
			!url.pathname.startsWith("/event/")
		) {
			continue;
		}

		url.search = "";
		url.hash = "";
		eventUrls.add(url.toString());
	}

	return [...eventUrls].sort();
}

function readSavedUrls(savedState) {
	let savedEvents = [];

	if (Array.isArray(savedState.seen_event_urls)) {
		savedEvents = savedState.seen_event_urls;
	} else if (Array.isArray(savedState.events)) {
		savedEvents = savedState.events;
	}

	return savedEvents
		.map((event) => {
			if (typeof event === "string") {
				return event;
			}

			if (event && typeof event.url === "string") {
				return event.url;
			}

			return null;
		})
		.filter(Boolean);
}

function readRecipientDeliveries(savedState) {
	const deliveries = new Map();
	const savedDeliveries = savedState?.recipient_delivery_ids;

	if (
		!savedDeliveries ||
		typeof savedDeliveries !== "object" ||
		Array.isArray(savedDeliveries)
	) {
		return deliveries;
	}

	for (const [eventUrl, recipientIds] of Object.entries(
		savedDeliveries,
	)) {
		if (!Array.isArray(recipientIds)) {
			continue;
		}

		deliveries.set(
			eventUrl,
			new Set(
				recipientIds.filter(
					(recipientId) =>
						typeof recipientId === "string",
				),
			),
		);
	}

	return deliveries;
}

async function getEventName(eventUrl) {
	const response = await fetch(eventUrl, {
		headers: {
			"User-Agent": "FIXR Event Monitor/1.0",
		},
	});

	if (!response.ok) {
		throw new Error(
			`FIXR event page returned status ${response.status}`,
		);
	}

	const html = await response.text();
	const headingMatch = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);

	if (!headingMatch) {
		return eventNameFromUrl(eventUrl);
	}

	const eventName = decodeHtml(
		headingMatch[1].replace(/<[^>]+>/g, " "),
	)
		.replace(/\s+/g, " ")
		.trim();

	return eventName || eventNameFromUrl(eventUrl);
}

function eventNameFromUrl(eventUrl) {
	const pathname = new URL(eventUrl).pathname;
	const slug =
		pathname.split("/").filter(Boolean).pop() || "new-event";

	return slug
		.replace(/-tickets-\d+$/i, "")
		.replace(/-/g, " ")
		.replace(/\b\w/g, (character) => character.toUpperCase())
		.trim();
}

function decodeHtml(value) {
	return value
		.replace(/&#x([0-9a-f]+);/gi, (_, code) =>
			String.fromCodePoint(Number.parseInt(code, 16)),
		)
		.replace(/&#(\d+);/g, (_, code) =>
			String.fromCodePoint(Number.parseInt(code, 10)),
		)
		.replace(/&nbsp;/gi, " ")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&amp;/gi, "&");
}

function getWhatsAppRecipients(env) {
	const configuredRecipients = parseWhatsAppRecipients(
		env.WHATSAPP_RECIPIENTS,
	);
	const recipients = configuredRecipients.length > 0
		? configuredRecipients
		: parseWhatsAppRecipients(env.WHATSAPP_TO);

	if (recipients.length === 0) {
		throw new Error("One or more WhatsApp secrets are missing.");
	}

	return recipients;
}

function parseWhatsAppRecipients(value) {
	if (!value) {
		return [];
	}

	return [
		...new Set(
			String(value)
				.split(",")
				.map((recipient) =>
					recipient.replace(/\s+/g, "").replace(/\D/g, ""),
				)
				.filter(Boolean),
		),
	];
}

async function recipientStateId(recipient) {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(recipient),
	);

	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

async function sendWhatsAppAlert(env, recipient, event) {
	if (
		!env.WHATSAPP_ACCESS_TOKEN ||
		!env.WHATSAPP_PHONE_NUMBER_ID ||
		!recipient
	) {
		throw new Error("One or more WhatsApp secrets are missing.");
	}

	const template = {
		name: WHATSAPP_TEMPLATE_NAME,
		language: {
			code: WHATSAPP_TEMPLATE_LANGUAGE,
		},
	};

	if (TEMPLATE_ACCEPTS_EVENT_DETAILS) {
		template.components = [
			{
				type: "body",
				parameters: [
					{
						type: "text",
						text: event.name,
					},
					{
						type: "text",
						text: event.url,
					},
				],
			},
		];
	}

	const response = await fetch(
		`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				messaging_product: "whatsapp",
				to: recipient,
				type: "template",
				template,
			}),
		},
	);

	if (!response.ok) {
		throw new Error(
			`WhatsApp returned status ${response.status}.`,
		);
	}
}

async function saveSeenState(
	env,
	eventUrls,
	recipientDeliveries = new Map(),
) {
	const recipientDeliveryIds = Object.fromEntries(
		[...recipientDeliveries.entries()]
			.filter(([, recipientIds]) => recipientIds.size > 0)
			.map(([eventUrl, recipientIds]) => [
				eventUrl,
				[...recipientIds].sort(),
			]),
	);

	await env.FIXR_STATE.put(
		STATE_KEY,
		JSON.stringify({
			seen_event_urls: [...new Set(eventUrls)].sort(),
			recipient_delivery_ids: recipientDeliveryIds,
			updated_at: new Date().toISOString(),
		}),
	);
}

function isWithinMonitoringWindow(date = new Date()) {
	const parts = new Intl.DateTimeFormat("en-GB", {
		timeZone: "Europe/London",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(date);

	const values = Object.fromEntries(
		parts
			.filter((part) => part.type !== "literal")
			.map((part) => [part.type, part.value]),
	);

	const ukMinutes =
		Number(values.hour) * 60 + Number(values.minute);

	return (
		ukMinutes >= MONITORING_START_MINUTES &&
		ukMinutes < MONITORING_END_MINUTES
	);
}
