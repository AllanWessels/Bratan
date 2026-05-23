import { create } from "zustand";

export type ToastVariant = "success" | "error" | "info";

export interface ToastItem {
  id: string;
  message: string;
  variant: ToastVariant;
}

interface UIStoreState {
  theme: "light" | "dark";
  sidebarCollapsed: boolean;
  toasts: ToastItem[];
  toggleTheme: () => void;
  toggleSidebar: () => void;
  pushToast: (message: string, variant?: ToastVariant) => void;
  dismissToast: (id: string) => void;
}

export const useUIStore = create<UIStoreState>((set) => ({
  theme: "light",
  sidebarCollapsed: false,
  toasts: [],
  toggleTheme: () => set((s) => ({ theme: s.theme === "light" ? "dark" : "light" })),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  pushToast: (message, variant = "info") =>
    set((s) => ({
      toasts: [...s.toasts, { id: crypto.randomUUID(), message, variant }],
    })),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
