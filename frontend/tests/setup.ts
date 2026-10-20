/**
 * Vitest setup for the frontend jsdom test layer.
 *
 * Registers the jest-dom DOM assertions (`toBeInTheDocument`, `toHaveValue`,
 * `toBeDisabled`, `toHaveTextContent`, `toHaveFocus`, ...) on Vitest's own
 * `expect`, so every suite in `frontend/tests` can use them. `frontend/vite.config.ts`
 * names this module as `setupFiles`, which is what loads it before each suite.
 */
import '@testing-library/jest-dom/vitest';
