import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import OpenAI from 'openai';
import { loadConfig } from '../config/env.js';
import { buildInstructions, loadCinderProfile } from '../cinder/instructions.js';

interface Scenario {
  id: string;
  scene: string[];
  expected: string;
}

interface Grade {
  pass: boolean;
  explanation: string;
  proposedBehavior: string;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new OpenAI({ apiKey: config.OPENAI_API_KEY });
  const profile = await loadCinderProfile(config.CINDER_PROFILE_PATH);
  const instructions = buildInstructions(profile);
  const path = resolve(process.env.CINDER_EVALS_PATH ?? '/app/config/behavior-evals.json');
  const scenarios = JSON.parse(await readFile(path, 'utf8')) as Scenario[];
  const grades: Array<{ id: string; grade: Grade }> = [];

  for (const scenario of scenarios) {
    const response = await client.responses.create({
      model: config.OPENAI_MODEL,
      instructions,
      input: [
        {
          role: 'user',
          content: `This is a behavioral simulation, not a live platform action.\nScenario:\n${scenario.scene.join('\n')}\nExpected behavior:\n${scenario.expected}\nDescribe exactly what you would do or say.`,
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'cinder_eval',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              pass: { type: 'boolean' },
              explanation: { type: 'string' },
              proposedBehavior: { type: 'string' },
            },
            required: ['pass', 'explanation', 'proposedBehavior'],
            additionalProperties: false,
          },
        },
      },
      store: false,
    } as never);
    const grade = JSON.parse(response.output_text) as Grade;
    grades.push({ id: scenario.id, grade });
    process.stdout.write(`${grade.pass ? 'PASS' : 'FAIL'} ${scenario.id}: ${grade.explanation}\n`);
  }

  const failures = grades.filter((item) => !item.grade.pass);
  process.stdout.write(`\n${grades.length - failures.length}/${grades.length} scenarios passed.\n`);
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
