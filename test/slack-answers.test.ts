import { describe, expect, it } from 'vitest';
import { approvalModal, formFields, modalData } from '../src/server/approvals.js';

/** The Slack answer form: built from a decision schema, and read back into typed decision data. */
const schema = {
  type: 'object',
  properties: {
    answers: { type: 'string', minLength: 1, title: 'Answers', description: 'One per question' },
    weight: { enum: ['auto', 'lite', 'full'], title: 'Review path' },
    urgent: { type: 'boolean', title: 'Urgent' },
    days: { type: 'integer', title: 'Days' },
  },
  required: ['answers'],
  additionalProperties: false,
};

describe('Slack answer form', () => {
  it('builds fields from strings, enums, booleans and numbers, and marks the required ones', () => {
    const f = formFields(schema)!;
    expect(f.map((x) => [x.name, x.kind, x.required])).toEqual([['answers', 'text', true], ['weight', 'select', false], ['urgent', 'select', false], ['days', 'number', false]]);
    expect(f[2]!.options).toEqual(['yes', 'no']);
  });

  it('declines a schema a modal cannot express, or one with nothing to ask', () => {
    expect(formFields(undefined)).toBeNull();
    expect(formFields({ type: 'object', properties: {} })).toBeNull();
    expect(formFields({ type: 'object', properties: { list: { type: 'array', items: { type: 'string' } } } })).toBeNull();
    expect(formFields({ type: 'object', properties: { o: { type: 'object' } } })).toBeNull();
  });

  it('puts one input per field in a modal that remembers the run, the node and the response URL', () => {
    const m = approvalModal({ run: 'run_1', node: 'clarification', responseUrl: 'https://hooks.slack/x', fields: formFields(schema)!, intro: 'Answer please' });
    expect(m).toMatchObject({ type: 'modal', callback_id: 'azhi_approval_form', submit: { text: 'Approve' } });
    expect(JSON.parse(m.private_metadata)).toEqual({ run: 'run_1', node: 'clarification', response_url: 'https://hooks.slack/x' });
    const inputs = m.blocks.filter((b: any) => b.type === 'input') as any[];
    expect(inputs.map((b: any) => [b.block_id, b.optional, b.element.type])).toEqual([['f_answers', false, 'plain_text_input'], ['f_weight', true, 'static_select'], ['f_urgent', true, 'static_select'], ['f_days', true, 'plain_text_input']]);
    expect(inputs[0]!.element.multiline).toBe(true);
    expect(m.title.text.length).toBeLessThanOrEqual(24);
  });

  it('reads submitted values back with the schema types, leaving empty optional fields out', () => {
    const fields = formFields(schema)!;
    const values = {
      f_answers: { answers: { type: 'plain_text_input', value: '  Settings live at /ui/tools.  ' } },
      f_weight: { weight: { type: 'static_select', selected_option: { value: 'lite' } } },
      f_urgent: { urgent: { type: 'static_select', selected_option: { value: 'yes' } } },
      f_days: { days: { type: 'plain_text_input', value: '3' } },
    };
    expect(modalData(schema, fields, values)).toEqual({ answers: 'Settings live at /ui/tools.', weight: 'lite', urgent: true, days: 3 });
    expect(modalData(schema, fields, { f_answers: values.f_answers, f_weight: { weight: { selected_option: null } }, f_days: { days: { value: '' } } })).toEqual({ answers: 'Settings live at /ui/tools.' });
  });

  it('names the field when a number is not a number', () => {
    const fields = formFields(schema)!;
    const bad = { f_days: { days: { value: '2.5' } } };
    expect(() => modalData(schema, fields, bad)).toThrow('Enter a whole number.');
    try {
      modalData(schema, fields, bad);
    } catch (e) {
      expect((e as { field?: string }).field).toBe('days');
    }
  });
});
