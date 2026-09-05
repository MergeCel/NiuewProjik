import type { Request, Response, NextFunction } from "express";

export function basicAuth(req: Request, res: Response, next: NextFunction) {
  // Allow cron secret bypass for internal calls
  const cronSecret = req.headers["x-cron-secret"] as string | undefined;
  if (cronSecret && cronSecret === process.env.CRON_SECRET) {
    return next();
  }

  const authHeader = req.headers.authorization;
  const user = process.env.ADMIN_USER;
  const pass = process.env.ADMIN_PASS;

  if (!user || !pass) {
    // if not configured, deny in production, allow in dev
    if (process.env.NODE_ENV === "production") {
      return res.status(500).json({ error: "Auth not configured" });
    }
    return next();
  }

  if (!authHeader || !authHeader.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Trading Bot"');
    return res.status(401).json({ error: "Unauthorized" });
  }

  const base64 = authHeader.split(" ")[1];
  const decoded = Buffer.from(base64, "base64").toString("utf-8");
  const [reqUser, reqPass] = decoded.split(":");

  if (reqUser === user && reqPass === pass) {
    return next();
  }

  res.setHeader("WWW-Authenticate", 'Basic realm="Trading Bot"');
  return res.status(401).json({ error: "Invalid credentials" });
}

export function cronAuth(req: Request, res: Response, next: NextFunction) {
  const secret = req.headers["x-cron-secret"] as string | undefined;
  const expected = process.env.CRON_SECRET;
  if (!expected) return next(); // allow if not set in dev
  if (secret === expected) return next();
  // also allow Authorization Bearer
  const auth = req.headers.authorization;
  if (auth === `Bearer ${expected}`) return next();
  return res.status(401).json({ error: "Invalid cron secret" });
}
