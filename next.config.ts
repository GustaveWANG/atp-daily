import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactStrictMode: true,
  // Autorise l'accès au dev server depuis le LAN (test iPhone sur le Wi-Fi)
  allowedDevOrigins: ["192.168.1.30"],
};

export default nextConfig;
