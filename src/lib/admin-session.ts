import crypto from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

const COOKIE = "bidfit_admin_session";
const secret = () => process.env.ADMIN_ACCESS_CODE ?? "";
const digest = (value: string) => crypto.createHmac("sha256", secret()).update(value).digest("hex");

export function isAdminCodeConfigured() { return secret().length > 0; }
export function verifyAdminCode(value: string) { if (!secret() || !value) return false; const expected = Buffer.from(digest(value)); const actual = Buffer.from(digest(secret())); return expected.length === actual.length && crypto.timingSafeEqual(expected, actual); }
export function createAdminSession(response: NextResponse) { const nonce = crypto.randomBytes(24).toString("hex"); response.cookies.set(COOKIE, `${nonce}.${digest(nonce)}`, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 7 }); }
export async function hasAdminSession() { const value = (await cookies()).get(COOKIE)?.value ?? ""; const [nonce, signature] = value.split("."); if (!nonce || !signature || !secret()) return false; const expected = Buffer.from(digest(nonce)); const actual = Buffer.from(signature); return expected.length === actual.length && crypto.timingSafeEqual(expected, actual); }
export function clearAdminSession(response: NextResponse) { response.cookies.set(COOKIE, "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 0 }); }
