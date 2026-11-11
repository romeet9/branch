import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Branch",
  description: "Iterate on UI with your own design system, one branch at a time.",
};

// Apply the saved theme before first paint so dark mode doesn't flash.
const themeScript = `try{if(localStorage.getItem('branch:theme')==='dark')document.documentElement.classList.add('dark')}catch(e){}`;

export default function StudioLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className="h-full antialiased">
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="h-full font-sans">{children}</body>
    </html>
  );
}
