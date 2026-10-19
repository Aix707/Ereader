/// <reference types="vite/client" />
import type { EreaderApi } from "./types";
declare global { interface Window { ereader: EreaderApi; } }
export {};
