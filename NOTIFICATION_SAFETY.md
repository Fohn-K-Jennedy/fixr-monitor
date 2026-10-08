# Notification safety

All scheduled runs use the same named SQLite-backed Durable Object, `timepiece-notifications-v1`. Do not rename it or delete its ledger: doing so discards notification history. The old FIXR_STATE KV is preserved but no longer controls sends.

On first initialization, the current FIXR events become a silent baseline. Existing events are not replayed. Events are keyed by numeric FIXR ID where available to avoid duplicate alerts after a slug change.

Each event/recipient attempt is durably recorded before the WhatsApp POST. There is at most one automatic attempt per pair. Pending or uncertain attempts pause processing and report a failed heartbeat; they are never automatically retried. This prioritizes avoiding duplicate messages over automatic recovery of missed messages. Meta acceptance is not proof of handset delivery. An operator must inspect provider receipts before repairing or clearing a blocked ledger.

Limits: 3 new events/check, 12 message attempts/check, 30 attempts in a rolling hour, and at most 10 configured recipients. Exceeding a limit pauses processing without sending the batch. Configuration and storage failures prevent sending.

Only GET /health is public. All other public paths return 404, including /test-whatsapp. Internal coordinator routes are accessible only through the Worker binding.

WHATSAPP_SENDING_ENABLED must be the string true to enable sending. Setting it false pauses new attempts; initial baseline collection is still permitted. Cron checks retain the 07:50–00:00 Europe/London window, and heartbeat delivery retries do not retry WhatsApp.

Run npm test for network-free safety and heartbeat tests. Run wrangler types after binding changes, and wrangler deploy --dry-run to validate bundling and configuration.
