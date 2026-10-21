import { Directive, ElementRef, afterRenderEffect, inject, input } from '@angular/core';
import { findMermaidSlots } from './markdown';
import { MermaidRendererService, type DiagramEntry } from './mermaid-renderer.service';

const SLOT_STYLE = 'svg{display:block;margin:0 auto;height:auto}';

/**
 * Draws each `.mermaid-slot` of the host's rendered Markdown as its diagram, in the slot's shadow
 * root, once rendered; the slot's code block stays the content until then and after a failure.
 */
@Directive({
  selector: '[appMermaidSlots]',
})
export class MermaidSlotsDirective {
  readonly appMermaidSlots = input.required<string>();

  private readonly host: HTMLElement = inject(ElementRef).nativeElement;
  private readonly diagrams = inject(MermaidRendererService);
  private readonly shown = new WeakMap<Element, DiagramEntry>();

  /** Hydrates the slots after every render that changed the HTML, the mode or a settled diagram. */
  constructor() {
    afterRenderEffect(() => {
      this.appMermaidSlots();
      this.diagrams.version();
      this.hydrate();
    });
  }

  private hydrate(): void {
    for (const { slot, source } of findMermaidSlots(this.host)) {
      const entry = this.diagrams.lookup(source);
      if (entry?.kind !== 'ready' || this.shown.get(slot) === entry) continue;
      const style = document.createElement('style');
      style.textContent = SLOT_STYLE;
      (slot.shadowRoot ?? slot.attachShadow({ mode: 'open' })).replaceChildren(
        style,
        entry.svg.cloneNode(true)
      );
      this.shown.set(slot, entry);
    }
  }
}
