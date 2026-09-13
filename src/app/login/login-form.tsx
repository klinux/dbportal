"use client";

import { appFetch, withBasePath } from "@/lib/config/base-path";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ExternalLink, KeyRound, Lock, Mail, ShieldCheck, Shield } from "lucide-react";
import { toast } from "sonner";
import { BrandMark, Wordmark } from "@/components/brand-mark";

/**
 * What the sign-in page says the product is. Three statements, each one true of the
 * deployment today (docs/CONTEXT.md §2): the page is unauthenticated, so it claims nothing a
 * visitor could not verify once inside.
 */
const PRODUCT_POINTS = [
  {
    title: "Datasources configured once",
    detail: "An administrator declares each database and injects its credentials. Nobody types a password.",
  },
  {
    title: "Access granted per datasource",
    detail: "Each datasource names the roles that may open it; the server decides, not the browser.",
  },
  {
    title: "One sign-in",
    detail: "Local accounts or your organisation's identity provider over OpenID Connect.",
  },
] as const;

function LoginFormInner({ authProvider }: { authProvider: string }) {
  const isOIDC = authProvider === "oidc";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  /**
   * Set once the server has answered `mfaRequired` for these credentials. The form never guesses
   * at it: whether an account carries a second factor is server-side configuration, and asking
   * the client to know it up front would mean publishing which accounts are protected.
   */
  const [mfaRequired, setMfaRequired] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();
  const oidcError = searchParams.get("error");

  /**
   * Editing either credential drops the second-factor step. Without this, changing the email
   * after being prompted would submit the new account with a code minted for the previous one -
   * a guaranteed failure that also spends a slot in the per-account rate-limit bucket.
   */
  const resetMfa = () => {
    setMfaRequired(false);
    setTotp("");
  };

  const handleLogin = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();

    if (!email || !password) {
      toast.error("Please enter email and password");
      return;
    }

    if (mfaRequired && !totp) {
      toast.error("Please enter your authentication code");
      return;
    }

    setIsLoading(true);
    try {
      const response = await appFetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // `totp` is omitted entirely until the server asks for it, so a deployment without MFA
        // sees exactly the request body it saw before.
        body: JSON.stringify(mfaRequired ? { email, password, totp } : { email, password }),
      });

      const data = await response.json();

      if (data.success) {
        toast.success(`Welcome back, ${data.role}!`);
        router.push(data.role === "admin" ? "/admin" : "/");
        router.refresh();
      } else if (data.mfaRequired) {
        // The first prompt needs no toast - the code field appearing IS the message, and an error
        // toast would frame a normal step of the flow as a failure. Being asked a second time
        // does mean the code was rejected, and that is worth saying out loud.
        if (mfaRequired) toast.error(data.message);
        setMfaRequired(true);
        setTotp("");
      } else {
        // data.message is the login route's own body ({ success: false, message }); data.error is
        // everything else that can refuse a login POST before or without reaching that body - the
        // proxy's Origin-mismatch 403 (src/proxy.ts) and the shared 429 envelope
        // (createErrorResponse) both carry `error`, not `message`. Without this fallback, a
        // reverse-proxy Host rewrite or a rate-limited legitimate user both see "Invalid email or
        // password" instead of the actionable text naming ALLOWED_ORIGINS or the retry window.
        toast.error(data.message || data.error || "Invalid email or password");
      }
    } catch {
      toast.error("An error occurred. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex min-h-[100dvh] bg-background">
      {/*
        Left Panel - Branding (hidden on mobile).

        Pinned dark with a nested `dark` class, which re-declares the token
        variables for this subtree only: the panel is a designed dark hero — a
        deep gradient, a dot grid at 4% white, a glow, and a heading that is
        literally `text-white` — and following the theme would put white type on a
        white ground. The sign-in half beside it follows the theme normally.
      */}
      <div className="dark hidden lg:flex lg:w-1/2 xl:w-[55%] relative overflow-hidden">
        <div className="absolute inset-0 bg-surface" />
        <div className="absolute inset-0 bg-gradient-to-b from-blue-950/20 via-transparent to-cyan-950/10" />

        {/* Dot grid pattern */}
        <div
          className="absolute inset-0 opacity-[0.04]"
          style={{
            backgroundImage: "radial-gradient(circle at 1px 1px, white 1px, transparent 0)",
            backgroundSize: "32px 32px",
          }}
        />

        {/* Ambient glow orbs — blue accent family */}
        <div className="absolute top-1/4 -left-20 w-80 h-80 bg-brand-tint/[0.07] rounded-full blur-3xl" />
        <div className="absolute bottom-1/3 right-10 w-64 h-64 bg-hue-cyan-tint/[0.05] rounded-full blur-3xl" />

        {/* Right edge separator */}
        <div className="absolute right-0 top-0 bottom-0 w-px bg-fill-strong" />

        {/* Content */}
        <div className="relative z-10 flex flex-col p-12 w-full overflow-y-auto">
          {/* Top: lockup. Not a link: there is no marketing site behind this product. */}
          <div className="flex items-center gap-4 w-fit" data-testid="login-lockup">
            <BrandMark className="h-12 w-12 text-white" />
            <Wordmark className="text-3xl text-white" />
          </div>

          {/*
            Thesis, then the three points - two tiers of weight. A single `mt-auto` here and
            none below, for the reason the previous hero learned the hard way: two auto
            margins split the column's free space and let the content overflow the page.
          */}
          <div className="space-y-8 mt-auto max-w-xl">
            <div className="space-y-4">
              <h1 className="text-4xl font-bold text-white tracking-tight leading-none">
                Shared access to the databases you already run.
              </h1>
              <p className="text-base text-fg-tertiary leading-relaxed">
                One portal, deployed next to your data. Every person signs in as themselves and reaches only the
                datasources an administrator shared with them.
              </p>
            </div>

            <ul className="space-y-4" data-testid="product-points">
              {PRODUCT_POINTS.map((point) => (
                <li key={point.title} className="flex gap-3">
                  <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium text-white">{point.title}</p>
                    <p className="text-sm text-fg-tertiary leading-relaxed">{point.detail}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {/* Right Panel - Login Form */}
      <div className="flex w-full lg:w-1/2 xl:w-[45%] items-center justify-center p-4 sm:p-6 lg:p-8">
        <div className="w-full max-w-md space-y-8">
          {/* Mobile branding (visible only on mobile) */}
          <div className="flex flex-col items-center gap-4 lg:hidden">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-raised border border-hairline-strong">
              <BrandMark className="h-10 w-10 text-foreground" />
            </div>
            <div className="text-center space-y-1">
              <Wordmark className="block text-2xl text-foreground" />
              <p className="text-sm text-muted-foreground">Shared database portal</p>
            </div>
          </div>

          <Card className="border-muted-foreground/10 shadow-2xl transition-all duration-300 hover:shadow-primary/5">
            {/* Desktop header inside card */}
            <CardHeader className="space-y-1 text-center pb-6 lg:pt-8">
              <CardTitle className="text-2xl font-bold tracking-tight">
                <span className="hidden lg:inline">Welcome back</span>
                <span className="lg:hidden">Sign in</span>
              </CardTitle>
              <CardDescription className="text-muted-foreground">
                <span className="hidden lg:inline">Sign in to dbportal</span>
                <span className="lg:hidden">Enter your credentials to continue</span>
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-6">
              {isOIDC ? (
                <>
                  {oidcError && (
                    <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
                      Authentication failed. Please try again.
                    </div>
                  )}

                  <div className="flex flex-col items-center text-center space-y-3 py-2">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                      <ShieldCheck className="h-6 w-6 text-primary" />
                    </div>
                    <div className="space-y-1">
                      <p className="text-sm font-medium text-foreground">Single Sign-On</p>
                      <p className="text-xs text-muted-foreground">
                        Sign in securely with your organization&apos;s identity provider
                      </p>
                    </div>
                  </div>

                  <Button
                    className="w-full h-11 text-base font-medium shadow-lg shadow-primary/20 active:scale-[0.98] transition-all gap-2"
                    onClick={() => {
                      setIsLoading(true);
                      window.location.href = withBasePath("/api/auth/oidc/login");
                    }}
                    disabled={isLoading}
                  >
                    <ExternalLink className="h-4 w-4" />
                    {isLoading ? "Redirecting..." : "Login with SSO"}
                  </Button>

                  {/*
                    One badge, not two. A lone "Encrypted" used to sit beside this one and named no
                    subject - and on the default STORAGE_PROVIDER=local deployment it had no
                    referent beyond the TLS the browser already indicates: credentials live in the
                    browser's localStorage in plaintext by design, and the at-rest AES-256-GCM in
                    src/lib/storage/encryption.ts covers the sqlite/postgres server store only.
                    "OIDC Protected" survives because it states something this branch actually does.
                  */}
                  <div className="flex items-center justify-center gap-4 pt-2">
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Shield className="h-3 w-3" />
                      <span>OIDC Protected</span>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <form onSubmit={handleLogin} className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="email">Email</Label>
                      <div className="relative group">
                        <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground transition-colors group-focus-within:text-primary" />
                        <Input
                          id="email"
                          type="email"
                          placeholder="Enter your email"
                          className="pl-10 h-11 transition-all focus:ring-2 focus:ring-primary/20"
                          value={email}
                          onChange={(e) => {
                            setEmail(e.target.value);
                            resetMfa();
                          }}
                          required
                        />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="password">Password</Label>
                      <div className="relative group">
                        <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground transition-colors group-focus-within:text-primary" />
                        <Input
                          id="password"
                          type="password"
                          placeholder="Enter your password"
                          className="pl-10 h-11 transition-all focus:ring-2 focus:ring-primary/20"
                          value={password}
                          onChange={(e) => {
                            setPassword(e.target.value);
                            resetMfa();
                          }}
                          required
                        />
                      </div>
                    </div>
                    {mfaRequired && (
                      <div className="space-y-2">
                        <Label htmlFor="totp">Authentication code</Label>
                        <div className="relative group">
                          <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground transition-colors group-focus-within:text-primary" />
                          <Input
                            id="totp"
                            name="totp"
                            /*
                             * `text` with an explicit numeric inputMode, not `number`: a number
                             * input strips a leading zero, and one in six codes starts with one.
                             * `one-time-code` is what lets iOS and macOS offer the code from the
                             * paired authenticator without the user leaving the page.
                             */
                            type="text"
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            pattern="[0-9]*"
                            maxLength={6}
                            /*
                             * The field appears mid-flow in response to the user's own submit, so
                             * moving focus to it is what a sighted user expects and what tells a
                             * screen-reader user the form grew a step.
                             */
                            autoFocus
                            placeholder="123456"
                            className="pl-10 h-11 tracking-[0.4em] font-mono transition-all focus:ring-2 focus:ring-primary/20"
                            value={totp}
                            onChange={(e) => setTotp(e.target.value)}
                            required
                          />
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Open your authenticator app and enter the current 6-digit code for this account.
                        </p>
                      </div>
                    )}
                    <Button
                      className="w-full h-11 text-base font-medium shadow-lg shadow-primary/20 active:scale-[0.98] transition-all"
                      type="submit"
                      disabled={isLoading}
                    >
                      {isLoading ? "Authenticating..." : mfaRequired ? "Verify code" : "Sign In"}
                    </Button>
                  </form>
                </>
              )}
            </CardContent>

            <CardFooter className="pt-0 pb-6 flex flex-col items-center gap-2">
              <p className="text-xs text-muted-foreground font-medium text-center max-w-[240px]">
                Access is granted per datasource by your administrator.
              </p>
              <span className="text-[10px] text-muted-foreground/60 font-mono">
                v{process.env.NEXT_PUBLIC_APP_VERSION}
              </span>
            </CardFooter>
          </Card>
        </div>
      </div>
    </div>
  );
}

export default function LoginForm({ authProvider }: { authProvider: string }) {
  return (
    <Suspense>
      <LoginFormInner authProvider={authProvider} />
    </Suspense>
  );
}
