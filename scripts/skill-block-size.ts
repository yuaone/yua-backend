import { listInstalledSkills } from "../src/skills/skills-registry";
import { renderSkillsBlock } from "../src/skills/skill-injector";

(async () => {
  const skills = await listInstalledSkills(8);
  const enabled = skills.filter(s => s.enabled);
  const block = renderSkillsBlock(enabled);
  const slugs = enabled.map(s => s.slug);
  const missingFromBlock = slugs.filter(slug => !block.includes(`slug="${slug}"`));
  console.log(`total: ${skills.length}`);
  console.log(`enabled: ${enabled.length}`);
  console.log(`block chars: ${block.length}`);
  console.log(`block KB: ${(block.length / 1024).toFixed(1)}`);
  console.log(`slugs in block: ${slugs.length - missingFromBlock.length}/${slugs.length}`);
  if (missingFromBlock.length > 0) {
    console.log(`MISSING: ${missingFromBlock.join(", ")}`);
  }
  process.exit(0);
})();
