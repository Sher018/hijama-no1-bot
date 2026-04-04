import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function projectRoot(): string {
  return path.resolve(__dirname, "../../..");
}

export function assetPath(...segments: string[]): string {
  return path.join(projectRoot(), "assets", "bot", ...segments);
}

export function fileExists(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Файл приветствия: положите сюда ваше изображение (см. assets/bot/README.txt). */
export const WELCOME_IMAGE_FILE = "welcome.png";

export type ServiceId =
  | "uvt"
  | "dry_needle"
  | "magnet_hi"
  | "magnet_vacuum"
  | "percussion"
  | "vacuum_gradient"
  | "soft_manual"
  | "hijama"
  | "massage";

export interface ServiceItem {
  id: ServiceId;
  buttonLabel: string;
  title: string;
  description: string;
  imageFile: string;
}

export const SERVICES: ServiceItem[] = [
  {
    id: "uvt",
    buttonLabel: "УВТ",
    title: "Ударно-волновая терапия (УВТ)",
    description: [
      "• уменьшение боли",
      "• снижение воспалительных проявлений",
      "• восстановление подвижности суставов",
      "• ускорение регенеративных процессов",
      "• улучшение микроциркуляции",
    ].join("\n"),
    imageFile: "uvt.png",
  },
  {
    id: "dry_needle",
    buttonLabel: "Сухая игла",
    title: "Метод сухой иглы",
    description:
      "Введение игл в триггерные точки вызывает активную импульсацию поражённой мышцы с последующим расслаблением и устранением патологического напряжения.",
    imageFile: "dry_needle.png",
  },
  {
    id: "magnet_hi",
    buttonLabel: "Магнит ВИ",
    title: "Магнит высокой интенсивности",
    description:
      "С помощью аппарата можно облегчить боль, ускорить процесс заживления переломов, а также расслабить или укрепить мышцы.",
    imageFile: "magnet_hi.png",
  },
  {
    id: "magnet_vacuum",
    buttonLabel: "Магнит-вакуум",
    title: "Магнитно-вакуумная акупунктура",
    description:
      "На концах — металлический стержень, магнит с северным или южным полюсами. Магнитное поле снимает спазм в мышцах, улучшает кровообращение и микроциркуляцию.",
    imageFile: "magnet_vacuum.png",
  },
  {
    id: "percussion",
    buttonLabel: "Перкуссия",
    title: "Перкуссионная терапия",
    description:
      "Улучшает кровообращение, расслабляет напряжённые мышцы, снимает боль в триггерных зонах, увеличивает свободу движения.",
    imageFile: "percussion.png",
  },
  {
    id: "vacuum_gradient",
    buttonLabel: "Вакуум-градиент",
    title: "Вакуум-градиентная терапия",
    description:
      "Формируемый в банке вакуум раздражает кожные рецепторы, что обеспечивает более высокий, чем обычно, местный приток крови к тканям.",
    imageFile: "vacuum_gradient.png",
  },
  {
    id: "soft_manual",
    buttonLabel: "Мануальные",
    title: "Мягкие мануальные техники",
    description:
      "Метод лечебно-механического воздействия руками на опорно-двигательный аппарат с целью устранения нарушения подвижности.",
    imageFile: "soft_manual.png",
  },
  {
    id: "hijama",
    buttonLabel: "Хиджама",
    title: "Хиджама",
    description:
      "Эффективный и простой способ избавления от многих болезней посредством выведения из организма застоявшейся крови.",
    imageFile: "hijama.png",
  },
  {
    id: "massage",
    buttonLabel: "Массаж",
    title: "Лечебный массаж",
    description:
      "Усиливает местное кровообращение, способствует оттоку лимфы из тканей и внутренних органов, стимулирует работу иммунной системы.",
    imageFile: "massage.png",
  },
];

export function getServiceById(id: string): ServiceItem | undefined {
  return SERVICES.find((s) => s.id === id);
}
