/**
 * Output-schema shapes of the normalised Jira objects that more than one tool returns.
 * @module mcp-atlassian/tools/jira-schemas
 */

const objectOf = (properties: Record<string, unknown>) => ({ type: 'object', properties });

const arrayOf = (item: Record<string, unknown>) => ({ type: 'array', items: item });

/** A Jira account, or `null` when the field is empty. */
export const userSchema = {
  type: ['object', 'null'],
  properties: { account_id: { type: 'string' }, name: { type: 'string' } },
};

/** A comment with its Markdown body. */
export const commentSchema = objectOf({
  id: { type: 'string' },
  body: { type: 'string', description: 'Markdown' },
  author: userSchema,
  created: { type: 'string' },
  updated: { type: 'string' },
});

/** A comment list. */
export const commentsSchema = arrayOf(commentSchema);

/** A worklog entry with its Markdown comment. */
export const worklogSchema = objectOf({
  id: { type: 'string' },
  issue_id: { type: 'string' },
  time_spent_seconds: { type: 'number' },
  comment: { type: ['string', 'null'], description: 'Markdown' },
  author: userSchema,
  started: { type: 'string' },
  created: { type: 'string' },
});

/** A component list. */
export const componentsSchema = arrayOf(
  objectOf({ id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' } })
);

/** A project. */
export const projectSchema = objectOf({
  id: { type: 'string' },
  key: { type: 'string' },
  name: { type: 'string' },
  project_type_key: { type: 'string' },
  lead: userSchema,
  url: { type: 'string' },
  components: componentsSchema,
});

/** A project list. */
export const projectsSchema = arrayOf(projectSchema);

/** An issue type list. */
export const issueTypesSchema = arrayOf(
  objectOf({
    id: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string' },
    subtask: { type: 'boolean' },
  })
);

/** An Agile board. */
export const boardSchema = objectOf({
  id: { type: 'number' },
  name: { type: 'string' },
  type: { type: 'string' },
  project_key: { type: 'string' },
});

/** An Agile board list. */
export const boardsSchema = arrayOf(boardSchema);

/** An Agile board configuration. */
export const boardConfigurationSchema = objectOf({
  id: { type: 'number' },
  name: { type: 'string' },
  filter_id: { type: 'string' },
  column_names: { type: 'array', items: { type: 'string' } },
});

/** An Agile sprint. */
export const sprintSchema = objectOf({
  id: { type: 'number' },
  name: { type: 'string' },
  state: { type: 'string' },
  board_id: { type: 'number' },
  goal: { type: 'string' },
  start_date: { type: 'string' },
  end_date: { type: 'string' },
  complete_date: { type: 'string' },
});

/** An Agile sprint list. */
export const sprintsSchema = arrayOf(sprintSchema);
