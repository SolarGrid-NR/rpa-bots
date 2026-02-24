'use server'

import fs from 'fs/promises';
import path from 'path';

export interface ActorDefinition {
    name: string;
    schema: any;
}

export async function getActors(): Promise<ActorDefinition[]> {
    const actorsDir = path.join(process.cwd(), 'actors');
    try {
        // Check if actors dir exists
        await fs.access(actorsDir);

        const entries = await fs.readdir(actorsDir, { withFileTypes: true });
        const actors: ActorDefinition[] = [];

        for (const entry of entries) {
            if (entry.isDirectory()) {
                try {
                    const schemaPath = path.join(actorsDir, entry.name, 'input_schema.json');
                    const schemaContent = await fs.readFile(schemaPath, 'utf-8');
                    actors.push({
                        name: entry.name,
                        schema: JSON.parse(schemaContent)
                    });
                } catch (e) {
                    console.warn(`Skipping actor ${entry.name}: No input_schema.json found`);
                }
            }
        }
        return actors;
    } catch (e) {
        console.error('Error listing actors:', e);
        return [];
    }
}
