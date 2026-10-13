/** Async reads carry snapshots, not authority over subsequent mutations.
 * Keep filtering, drawer selection and write boundaries independently ordered.
 * No timers: the caller marks a mutation both before requesting it and when it
 * commits, invalidating reads begun on either side of an in-flight write.
 */
type LoadTicket = { readonly load: number; readonly selection: number; readonly mutation: number };
type SelectionTicket = { readonly selection: number; readonly mutation: number };

export class OrderReadConsistency {
  private load = 0;
  private selection = 0;
  private mutation = 0;

  beginLoad(): LoadTicket {
    return { load: ++this.load, selection: this.selection, mutation: this.mutation };
  }

  beginSelection(): SelectionTicket {
    return { selection: ++this.selection, mutation: this.mutation };
  }

  recordMutation(): void { this.mutation += 1; }

  isLatestLoad(ticket: LoadTicket): boolean { return ticket.load === this.load; }

  canApplyLoad(ticket: LoadTicket): boolean {
    return this.isLatestLoad(ticket) && ticket.mutation === this.mutation;
  }

  canApplyLoadSelection(ticket: LoadTicket): boolean {
    return this.canApplyLoad(ticket) && ticket.selection === this.selection;
  }

  canApplySelection(ticket: SelectionTicket): boolean {
    return ticket.selection === this.selection && ticket.mutation === this.mutation;
  }
}
