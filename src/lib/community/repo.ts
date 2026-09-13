/**
 * The one place the public repository URL is written.
 *
 * It is referenced by the header/sidebar link, by the error page and by the boot
 * banner. Those live in different runtimes (client component, server module), which
 * is exactly how a rename ends up fixed in the visible copies and missed in the rest.
 */
export const REPO_URL = "https://github.com/klinux/dbportal";
