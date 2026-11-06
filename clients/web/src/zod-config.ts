import { z } from 'zod';

/**
 * Zod probes whether the page may build code at run time (`new Function("")`) and swallows the failure, but a strict
 * content-security policy still reports it as a violation on every page load. The browser has no use for that fast path,
 * so turn it off. This module is the first import of `main.tsx`, so it runs before any schema is used.
 */
z.config({ jitless: true });
