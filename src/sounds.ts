/**
 * Bark's bundled sounds, from the app's `Sounds/*.caf` resources.
 *
 * The list is a hint, not a whitelist: a name the app does not know falls back to the default
 * notification sound, and a user can add their own `.caf` files in the app.
 */
export const BARK_SOUNDS = [
	"alarm",
	"anticipate",
	"bell",
	"birdsong",
	"bloom",
	"calypso",
	"chime",
	"choo",
	"descent",
	"electronic",
	"fanfare",
	"glass",
	"gotosleep",
	"healthnotification",
	"horn",
	"ladder",
	"mailsent",
	"minuet",
	"multiwayinvitation",
	"newmail",
	"newsflash",
	"noir",
	"paymentsuccess",
	"shake",
	"sherwoodforest",
	"silence",
	"spell",
	"suspense",
	"telegraph",
	"tiptoes",
	"typewriters",
	"update",
] as const;

/** One line for the tool description, so the model picks from names that exist. */
export const SOUND_HINT = `Bark sounds: ${BARK_SOUNDS.join(", ")}; any other name falls back to the device default.`;
