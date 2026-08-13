import { bootstrapApplication } from '@angular/platform-browser';
import {
  CSP_NONCE,
  ErrorHandler,
  provideAppInitializer,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideRouter, withInMemoryScrolling } from '@angular/router';
import { AppComponent } from './app/app.component';
import { routes } from './app/app.routes';
import { GlobalErrorHandler } from './app/error-handler';
import { applyPersistedThemeOnStartup } from './app/services/theme.service';

/**
 * Read the nonce Tauri injected into the boot-overlay <style> tag in index.html.
 *  Passing it to CSP_NONCE lets Angular add the same nonce to all component <style> tags.
 */
const tauriNonce = document.getElementById('boot-overlay-style')?.nonce || '';

bootstrapApplication(AppComponent, {
  providers: [
    provideZonelessChangeDetection(),
    provideAppInitializer(applyPersistedThemeOnStartup),
    // `anchorScrolling: enabled` scrolls an `id="..."` element into view on a `fragment="..."`
    // navigation — required for the System health → IDE Bridge `connect →` deep link.
    provideRouter(
      routes,
      withInMemoryScrolling({
        anchorScrolling: 'enabled',
        scrollPositionRestoration: 'enabled',
      })
    ),
    { provide: ErrorHandler, useClass: GlobalErrorHandler },
    ...(tauriNonce ? [{ provide: CSP_NONCE, useValue: tauriNonce }] : []),
  ],
}).catch((err) => {
  // Bootstrap failed before Angular DI exists, so route the error straight to
  // the Rust log pipeline (the GlobalErrorHandler is the only console bridge).
  import('@tauri-apps/plugin-log')
    .then(({ error }) => error(`[Bootstrap] ${String(err)}`))
    .catch(() => {});
});
