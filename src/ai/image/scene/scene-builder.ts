import type { VisionHint } from "./vision-analyzer";

export interface SceneGraph {
  entities: Array<{
    id: string;
    type: string;
    pose?: string;
    attributes?: Record<string, any>;
  }>;
  relations: Array<{
    from: string;
    to: string;
    type: string;
  }>;
  mood?: string;
}

/* --------------------------------------------------
   🔒 SSOT: 이미지 프롬프트 인젝션 방어
   - 유저 메시지가 scene.description에 직접 삽입되므로 sanitize 필수
-------------------------------------------------- */
const BLOCKED_PATTERNS = [
  // EN: prompt injection
  /ignore.*(?:constraint|instruction|rule|prompt|above|previous|system)/gi,
  /disregard.*(?:above|previous|system|constraint)/gi,
  /generate.*(?:harmful|illegal|dangerous)/gi,
  // EN: unsafe content
  /nsfw|nude|naked|explicit|porn|gore|violence|weapon|drug/gi,
  /\bkill\b|murder|suicide|self.?harm/gi,
  // KO: 프롬프트 인젝션
  /무시.*(?:규칙|지시|제약|명령|시스템|위|이전)/gi,
  /(?:규칙|제약|지시).*(?:무시|해제|취소|없애)/gi,
  // KO: 유해 콘텐츠
  /음란|야동|누드|포르노|노출|폭력|살인|자살|자해|마약|총기|무기/gi,
  // JP: プロンプトインジェクション + 有害
  /無視.*(?:ルール|指示|制約)|(?:ルール|制約).*無視/gi,
  /ヌード|ポルノ|暴力|殺人|自殺|自傷|薬物/gi,
  // ZH: 提示注入 + 有害
  /忽略.*(?:规则|指令|约束)|(?:规则|约束).*忽略/gi,
  /色情|裸体|暴力|杀人|自杀|自残|毒品/gi,
];
const MAX_DESCRIPTION_LENGTH = 500;

function sanitizeDescription(text: string): string {
  let clean = text;
  for (const pattern of BLOCKED_PATTERNS) {
    clean = clean.replace(pattern, "");
  }
  clean = clean.replace(/```[\s\S]*?```/g, "");
  clean = clean.replace(/\{[\s\S]*?\}/g, "");
  return clean.slice(0, MAX_DESCRIPTION_LENGTH).trim();
}

export function buildSceneFromText(input: {
  message: string;
  sectionType: string;
  visionHint?: VisionHint | null;
}) {
  const safeDescription = sanitizeDescription(input.message);

  // 🔒 SSOT: visionHint 없으면 추상 개체만 허용
  if (!input.visionHint) {
    return {
      entities: [
        {
          id: "object",
          type: "generic_object",
          attributes: {
            clarity: "high",
            description: safeDescription,
          },
        },
      ],
      relations: [],
      mood: "neutral",
    };
  }

  const isHuman = input.visionHint.hasHuman === true;

  return {
    entities: [
      isHuman
        ? {
            id: "subject",
            type: "human_subject",
            pose: input.visionHint.poseHint ?? "standing",
            attributes: {
              realism: "photo_realistic",
              lighting: "soft_studio",
              anatomy: "accurate",
              faceDetail: "high",
              renderStyle: "sharp",
            },
          }
        : {
            id: "object",
            type: "designed_object",
            attributes: {
              geometry: "precise",
              edges: "sharp",
              material: "matte",
              renderStyle: "clean",
            },
          },
    ],
    relations: [],
    mood: "clear_professional",
  };
}  
