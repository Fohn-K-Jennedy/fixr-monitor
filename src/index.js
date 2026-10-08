// Emergency shutdown: no FIXR checks, heartbeat requests, or WhatsApp sends.
// Previous implementation is preserved in Git history.
export default {
	async fetch(request) {
		const health = new URL(request.url).pathname === "/health";
		return Response.json({
			success: false,
			status: "emergency_paused",
			release: "emergency-whatsapp-shutdown",
			whatsapp_sending_enabled: false,
			scheduled_checks_enabled: false,
		}, { status: health ? 200 : 503 });
	},
	async scheduled() {
		console.warn("Emergency pause: scheduled processing and WhatsApp sending disabled.");
	},
};
