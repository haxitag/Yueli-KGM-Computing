export class OpenAiResponseStore {
    responses = new Map();
    save(record) {
        this.responses.set(record.id, record);
    }
    get(id) {
        return this.responses.get(id);
    }
}
