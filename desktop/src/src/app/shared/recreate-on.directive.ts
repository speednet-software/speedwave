import { Directive, OnChanges, TemplateRef, ViewContainerRef, inject, input } from '@angular/core';

/** Renders its template anew whenever the bound key changes, so no view state outlives the key. */
@Directive({
  selector: '[appRecreateOn]',
})
export class RecreateOnDirective implements OnChanges {
  /** The key whose change recreates the view, e.g. the active project. */
  readonly appRecreateOn = input.required<unknown>();

  private readonly template = inject(TemplateRef);
  private readonly container = inject(ViewContainerRef);

  /** Creates the view on the first binding and recreates it on every change of the key. */
  ngOnChanges(): void {
    this.container.clear();
    this.container.createEmbeddedView(this.template);
  }
}
