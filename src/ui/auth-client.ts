"use client";

import { createAuthClient } from "better-auth/react";

/** Same-origin auth client. The session lives in an httpOnly cookie; nothing secret is readable from JS. */
export const authClient = createAuthClient();

export { DEMO_ACCOUNT } from "./demo-account";
