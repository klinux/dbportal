import type { SshProfile } from "@/lib/seed/types";

/** A profile the admin API stored: the declaration plus who wrote it and when. */
export interface SshProfileRecord extends SshProfile {
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}

/** Where a profile came from: the seed file (read-only here) or the store. */
export type SshProfileSource = "config" | "store";

/**
 * A profile as the admin API returns it: every secret replaced by whether it is set and,
 * when it is a reference, the reference - never the value.
 */
export interface SshProfileView extends Omit<SshProfile, "password" | "privateKey" | "passphrase"> {
  source: SshProfileSource;
  hasPassword: boolean;
  hasPrivateKey: boolean;
  hasPassphrase: boolean;
  passwordRef?: string;
  privateKeyRef?: string;
  createdAt?: string;
  updatedAt?: string;
  updatedBy?: string;
}
