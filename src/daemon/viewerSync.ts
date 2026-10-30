/**
 * The gate that keeps one viewer socket's byte stream in order across
 * snapshots (design §5).
 *
 * A snapshot of the daemon's renderer is taken asynchronously: it resolves
 * once every byte queued before the request has been parsed, and includes
 * nothing queued after it (`ScreenRenderer.serialize`). Bytes that arrive
 * while it is pending are NOT in it and must reach the viewer
 * AFTER it; bytes that arrived before the request ARE in it and were already
 * forwarded live, so they must not go out again. This class is that
 * bookkeeping, with the socket and the snapshot injected so it can be tested
 * without either.
 *
 * No I/O of its own and no logging.
 */
export class ViewerSync {
  /** Arrival counter: every delivered chunk takes the next value. */
  private seq = 0;
  /** Chunks held back while a snapshot is pending, with their arrival order. */
  private held: { seq: number; bytes: string }[] = [];
  /** The arrival counter at each pending snapshot request, oldest first. */
  private readonly pending: number[] = [];
  private closed = false;

  constructor(
    private readonly send: (bytes: string) => void,
    private readonly snapshot: () => Promise<string>,
  ) {}

  /** Live bytes from the session, in arrival order. */
  deliver(bytes: string): void {
    if (this.closed) return;
    const seq = this.seq++;
    if (this.pending.length === 0) {
      this.send(bytes);
      return;
    }
    this.held.push({ seq, bytes });
  }

  /**
   * Send a fresh snapshot, then everything that arrived after it was taken.
   * Requests may overlap (a window being dragged): each snapshot goes out
   * once, and no chunk goes out twice or not at all.
   */
  resync(): void {
    if (this.closed) return;
    // Everything delivered before this point is in the snapshot about to be
    // taken: the session writes a chunk to its renderer before it notifies
    // listeners, and the snapshot's marker joins the renderer's queue now.
    const mark = this.seq;
    this.pending.push(mark);
    this.snapshot().then(
      (state) => this.complete(mark, state),
      () => this.complete(mark, null),
    );
  }

  private complete(mark: number, state: string | null): void {
    if (this.closed) return;
    // Snapshots resolve in request order: the renderer's write queue is FIFO.
    this.pending.shift();
    if (state !== null) {
      this.send(state);
      // Chunks that arrived before this snapshot was requested are inside it.
      // Only a snapshot that WENT OUT accounts for them: one that failed
      // covers nothing, and pruning on its mark would lose every chunk between
      // the previous request and this one. Those are released live instead,
      // in order.
      this.held = this.held.filter((entry) => entry.seq >= mark);
    }
    if (this.pending.length === 0) {
      const release = this.held;
      this.held = [];
      for (const entry of release) this.send(entry.bytes);
    }
  }

  /** Nothing goes out after this, including a snapshot that resolves late. */
  close(): void {
    this.closed = true;
    this.held = [];
  }
}
