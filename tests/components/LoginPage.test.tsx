import "../setup-dom";
import React from "react";
import { mockRouterPush, mockRouterRefresh } from "../helpers/mock-navigation";
import { mockToastSuccess, mockToastError } from "../helpers/mock-sonner";
import { mock } from "bun:test";

// sonner and next/navigation are mocked via preload
// lucide-react resolves fine natively — no mock needed

const { default: LoginForm } = await import("@/app/login/login-form");

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

function renderLogin() {
  const user = userEvent.setup();
  const result = render(<LoginForm authProvider="local" />);
  const form = result.container.querySelector("form")!;
  const emailInput = result.container.querySelector('input[type="email"]')! as HTMLInputElement;
  const passwordInput = result.container.querySelector('input[type="password"]')! as HTMLInputElement;
  return { ...result, form, emailInput, passwordInput, user };
}

describe("LoginPage", () => {
  beforeEach(() => {
    mockRouterPush.mockClear();
    mockRouterRefresh.mockClear();
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
    globalThis.fetch = mock(() => Promise.resolve(new Response("{}"))) as never;
  });

  afterEach(() => {
    cleanup();
  });

  test("renders login form with email and password inputs", () => {
    const { emailInput, passwordInput } = renderLogin();
    expect(emailInput).not.toBeNull();
    expect(emailInput.type).toBe("email");
    expect(passwordInput).not.toBeNull();
    expect(passwordInput.type).toBe("password");
  });

  test("renders Sign In button", () => {
    const { getByText } = renderLogin();
    expect(getByText("Sign In")).not.toBeNull();
  });

  test("renders the dbportal wordmark on both surfaces", () => {
    // Desktop hero and mobile header each carry the lockup; the wordmark is always lowercase.
    const { getAllByText } = renderLogin();
    expect(getAllByText("dbportal").length).toBeGreaterThanOrEqual(2);
  });

  // The sign-in page is unauthenticated, so the only outbound link it may carry is none: the
  // upstream hero linked to a marketing site and eight social profiles, and this product has
  // neither. Asserted on the whole page rather than a block, so a link cannot creep back in.
  test("carries no outbound link", () => {
    const { container } = renderLogin();
    expect(container.querySelectorAll("a").length).toBe(0);
  });

  test("states what the product is, without upstream marketing claims", () => {
    const { container, getByTestId } = renderLogin();
    expect(getByTestId("product-points").querySelectorAll("li").length).toBe(3);
    const text = container.textContent ?? "";
    expect(text).toContain("Shared access to the databases you already run.");
    expect(text).not.toContain("LibreDB");
    expect(text).not.toContain("install channels");
    expect(text).not.toContain("Open-source SQL IDE");
  });

  test("shows error toast when submitting empty form", () => {
    const { form } = renderLogin();
    fireEvent.submit(form);
    expect(mockToastError).toHaveBeenCalledWith("Please enter email and password");
  });

  test("calls fetch with correct payload on form submit", async () => {
    const mockFetch = mock(() => Promise.resolve(new Response(JSON.stringify({ success: true, role: "admin" }))));
    globalThis.fetch = mockFetch as never;

    const { form, emailInput, passwordInput, user } = renderLogin();
    await user.type(emailInput, "admin@libredb.org");
    await user.type(passwordInput, "LibreDB.2026");
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    const [url, options] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/auth/login");
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body as string)).toEqual({ email: "admin@libredb.org", password: "LibreDB.2026" });
  });

  test("redirects admin to /admin on success", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ success: true, role: "admin" }))),
    ) as never;

    const { form, emailInput, passwordInput, user } = renderLogin();
    await user.type(emailInput, "admin@libredb.org");
    await user.type(passwordInput, "LibreDB.2026");
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockRouterPush).toHaveBeenCalledWith("/admin");
    });
    expect(mockRouterRefresh).toHaveBeenCalled();
    expect(mockToastSuccess).toHaveBeenCalledWith("Welcome back, admin!");
  });

  test("redirects user to / on success", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ success: true, role: "user" }))),
    ) as never;

    const { form, emailInput, passwordInput, user } = renderLogin();
    await user.type(emailInput, "user@libredb.org");
    await user.type(passwordInput, "LibreDB.2026");
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockRouterPush).toHaveBeenCalledWith("/");
    });
    expect(mockToastSuccess).toHaveBeenCalledWith("Welcome back, user!");
  });

  test("shows error toast on failed login", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ success: false, message: "Invalid email or password" }))),
    ) as never;

    const { form, emailInput, passwordInput, user } = renderLogin();
    await user.type(emailInput, "wrong@example.com");
    await user.type(passwordInput, "wrong");
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("Invalid email or password");
    });
  });

  test("falls back to the response's error field when message is absent (origin-mismatch/rate-limit shape)", async () => {
    // The proxy's Origin-mismatch 403 and the shared 429 envelope both carry `error`, not
    // `message` - unlike the login route's own body. Without the fallback this reads as
    // `data.message || "Invalid email or password"`, so a rate-limited or origin-refused caller
    // would incorrectly be told their password is wrong.
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: "Request origin is not allowed for this deployment. Set ALLOWED_ORIGINS.",
            code: "ORIGIN_MISMATCH",
          }),
        ),
      ),
    ) as never;

    const { form, emailInput, passwordInput, user } = renderLogin();
    await user.type(emailInput, "admin@libredb.org");
    await user.type(passwordInput, "correct-password");
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        "Request origin is not allowed for this deployment. Set ALLOWED_ORIGINS.",
      );
    });
  });

  test("shows generic error toast on network failure", async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error("Network error"))) as never;

    const { form, emailInput, passwordInput, user } = renderLogin();
    await user.type(emailInput, "test@example.com");
    await user.type(passwordInput, "test");
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("An error occurred. Please try again.");
    });
  });

  test("shows Authenticating... text while loading", async () => {
    let resolveFetch!: (v: Response) => void;
    globalThis.fetch = mock(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    ) as never;

    const { form, emailInput, passwordInput, user, queryByText } = renderLogin();
    await user.type(emailInput, "test@example.com");
    await user.type(passwordInput, "test");
    fireEvent.submit(form);

    await waitFor(() => {
      expect(queryByText("Authenticating...")).not.toBeNull();
    });

    resolveFetch(new Response(JSON.stringify({ success: false })));
    await waitFor(() => {
      expect(queryByText("Sign In")).not.toBeNull();
    });
  });
});

describe("LoginPage route (app/login/page)", () => {
  const savedAuthProvider = process.env.NEXT_PUBLIC_AUTH_PROVIDER;

  afterEach(() => {
    if (savedAuthProvider === undefined) {
      delete process.env.NEXT_PUBLIC_AUTH_PROVIDER;
    } else {
      process.env.NEXT_PUBLIC_AUTH_PROVIDER = savedAuthProvider;
    }
    cleanup();
  });

  test("forces dynamic rendering so the auth provider is read at runtime", async () => {
    const { dynamic } = await import("@/app/login/page");
    expect(dynamic).toBe("force-dynamic");
  });

  test("defaults to the local login form when no auth provider is set", async () => {
    delete process.env.NEXT_PUBLIC_AUTH_PROVIDER;
    const { default: LoginPageRoute } = await import("@/app/login/page");

    const { container } = render(<LoginPageRoute />);
    expect(container.querySelector("form")).not.toBeNull();
  });

  test("renders the SSO login when NEXT_PUBLIC_AUTH_PROVIDER is oidc", async () => {
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "oidc";
    const { default: LoginPageRoute } = await import("@/app/login/page");

    const { queryByText, container } = render(<LoginPageRoute />);
    expect(queryByText("Login with SSO")).not.toBeNull();
    expect(container.querySelector("form")).toBeNull();
  });
});

/**
 * The second-factor step of the local login flow. The form is deliberately ignorant of whether
 * an account is MFA-protected until the server says so, so every case here drives that state the
 * only way the real app can: through a response body.
 */
describe("LoginPage TOTP step", () => {
  const MFA_PROMPT = "Enter the 6-digit code from your authenticator app";
  const MFA_INVALID = "Invalid authentication code";

  function respondWith(...bodies: object[]) {
    let call = 0;
    const mockFetch = mock(() => {
      const body = bodies[Math.min(call, bodies.length - 1)];
      call += 1;
      return Promise.resolve(new Response(JSON.stringify(body)));
    });
    globalThis.fetch = mockFetch as never;
    return mockFetch;
  }

  function codeInput(container: HTMLElement) {
    return container.querySelector("#totp") as HTMLInputElement | null;
  }

  /** Fills in the credentials and submits once, leaving the form on whatever step it reached. */
  async function submitCredentials(result: ReturnType<typeof renderLogin>) {
    await result.user.type(result.emailInput, "admin@libredb.org");
    await result.user.type(result.passwordInput, "LibreDB.2026");
    fireEvent.submit(result.form);
  }

  beforeEach(() => {
    mockRouterPush.mockClear();
    mockRouterRefresh.mockClear();
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
    globalThis.fetch = mock(() => Promise.resolve(new Response("{}"))) as never;
  });

  afterEach(() => {
    cleanup();
  });

  test("hides the code field until the server asks for one", () => {
    const { container } = renderLogin();
    expect(codeInput(container)).toBeNull();
  });

  test("reveals the code field when the server answers mfaRequired", async () => {
    respondWith({ success: false, mfaRequired: true, message: MFA_PROMPT });

    const result = renderLogin();
    await submitCredentials(result);

    await waitFor(() => expect(codeInput(result.container)).not.toBeNull());
    expect(result.getByText("Verify code")).not.toBeNull();
  });

  test("does not frame the first prompt as an error", async () => {
    respondWith({ success: false, mfaRequired: true, message: MFA_PROMPT });

    const result = renderLogin();
    await submitCredentials(result);

    // The field appearing is the message. A toast here would read as a failure to a user who
    // has done nothing wrong yet.
    await waitFor(() => expect(codeInput(result.container)).not.toBeNull());
    expect(mockToastError).not.toHaveBeenCalled();
  });

  test("offers the code field to the platform autofill rather than a bare text box", async () => {
    respondWith({ success: false, mfaRequired: true, message: MFA_PROMPT });

    const result = renderLogin();
    await submitCredentials(result);

    await waitFor(() => expect(codeInput(result.container)).not.toBeNull());
    const field = codeInput(result.container)!;
    expect(field.autocomplete).toBe("one-time-code");
    expect(field.inputMode).toBe("numeric");
    // `number` would strip the leading zero that one code in six starts with.
    expect(field.type).toBe("text");
  });

  test("sends the code alongside the credentials on the second request", async () => {
    const mockFetch = respondWith(
      { success: false, mfaRequired: true, message: MFA_PROMPT },
      { success: true, role: "admin" },
    );

    const result = renderLogin();
    await submitCredentials(result);
    await waitFor(() => expect(codeInput(result.container)).not.toBeNull());

    await result.user.type(codeInput(result.container)!, "287082");
    fireEvent.submit(result.form);

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    const [, options] = mockFetch.mock.calls[1] as unknown as [string, RequestInit];
    expect(JSON.parse(options.body as string)).toEqual({
      email: "admin@libredb.org",
      password: "LibreDB.2026",
      totp: "287082",
    });
    await waitFor(() => expect(mockRouterPush).toHaveBeenCalledWith("/admin"));
  });

  test("surfaces the server's wording when a code is rejected, and clears the field", async () => {
    respondWith(
      { success: false, mfaRequired: true, message: MFA_PROMPT },
      { success: false, mfaRequired: true, message: MFA_INVALID },
    );

    const result = renderLogin();
    await submitCredentials(result);
    await waitFor(() => expect(codeInput(result.container)).not.toBeNull());

    await result.user.type(codeInput(result.container)!, "000000");
    fireEvent.submit(result.form);

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(MFA_INVALID));
    expect(codeInput(result.container)!.value).toBe("");
  });

  test("refuses to submit an empty code rather than spending a rate-limit slot on it", async () => {
    const mockFetch = respondWith({ success: false, mfaRequired: true, message: MFA_PROMPT });

    const result = renderLogin();
    await submitCredentials(result);
    await waitFor(() => expect(codeInput(result.container)).not.toBeNull());

    fireEvent.submit(result.form);

    expect(mockToastError).toHaveBeenCalledWith("Please enter your authentication code");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("drops back to the password step when the email is edited", async () => {
    respondWith({ success: false, mfaRequired: true, message: MFA_PROMPT });

    const result = renderLogin();
    await submitCredentials(result);
    await waitFor(() => expect(codeInput(result.container)).not.toBeNull());

    await result.user.type(result.emailInput, "x");

    // A code minted for the previous account would fail and cost that account a slot in the
    // per-account limiter, so the step resets with the credentials it was issued against.
    await waitFor(() => expect(codeInput(result.container)).toBeNull());
    expect(result.getByText("Sign In")).not.toBeNull();
  });

  test("drops back to the password step when the password is edited", async () => {
    respondWith({ success: false, mfaRequired: true, message: MFA_PROMPT });

    const result = renderLogin();
    await submitCredentials(result);
    await waitFor(() => expect(codeInput(result.container)).not.toBeNull());

    await result.user.type(result.passwordInput, "x");

    await waitFor(() => expect(codeInput(result.container)).toBeNull());
  });
});
