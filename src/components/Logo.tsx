import React from "react";

interface LogoProps {
  className?: string;
}

export default function Logo({ className }: LogoProps) {
  return (
    <img
      src="/logo.png"
      alt="Carbon Logo"
      className={className}
      style={{ objectFit: "contain" }}
    />
  );
}
