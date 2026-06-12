class SseStreamParser {
    constructor(onEvent) {
        if (typeof onEvent !== 'function') {
            throw new Error('SseStreamParser requires an onEvent callback');
        }
        this.onEvent = onEvent;
        this.buffer = '';
        this.currentEvent = { event: '', data: '' };
    }

    feed(text) {
        if (!text) return;
        this.buffer += text;

        let boundary;
        while ((boundary = this.buffer.indexOf('\n')) !== -1) {
            const rawLine = this.buffer.slice(0, boundary);
            this.buffer = this.buffer.slice(boundary + 1);
            this.handleLine(rawLine.replace(/\r$/, ''));
        }
    }

    flush() {
        if (!this.buffer && !this.currentEvent.data) return;
        const trailing = this.buffer.replace(/\r$/, '');
        this.buffer = '';
        if (trailing) this.handleLine(trailing);
        this.emitCurrentEvent();
    }

    handleLine(line) {
        if (line === '') {
            this.emitCurrentEvent();
            return;
        }

        if (line.startsWith(':')) return;

        const colon = line.indexOf(':');
        const field = colon >= 0 ? line.slice(0, colon) : line;
        let value = colon >= 0 ? line.slice(colon + 1) : '';
        if (value.startsWith(' ')) value = value.slice(1);

        switch (field) {
            case 'event':
                this.currentEvent.event = value;
                break;
            case 'data':
                this.currentEvent.data = this.currentEvent.data
                    ? this.currentEvent.data + '\n' + value
                    : value;
                break;
            case 'id':
            case 'retry':
                // Not needed by the proxy adapters, but keep the parser spec-shaped.
                break;
            default:
                // Unknown fields are ignored by SSE parsers.
                break;
        }
    }

    emitCurrentEvent() {
        if (!this.currentEvent.data) {
            this.currentEvent = { event: '', data: '' };
            return;
        }
        this.onEvent(this.currentEvent.event || 'message', this.currentEvent.data);
        this.currentEvent = { event: '', data: '' };
    }
}

module.exports = { SseStreamParser };
