/**
 * `.value` of an input/select/textarea change or input event target.
 * @param ev - the DOM event.
 */
export function eventValue(ev: Event): string {
  return (ev.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value;
}

/**
 * `.checked` of a checkbox change event target.
 * @param ev - the DOM event.
 */
export function eventChecked(ev: Event): boolean {
  return (ev.target as HTMLInputElement).checked;
}
