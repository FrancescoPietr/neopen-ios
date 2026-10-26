// Stub sostitutivo di PUIController (Paper UI: pulsanti stampati su fogli speciali).
// L'originale dipende da jQuery e da file .nproj; per questo plugin non serve.
import { PageInfo } from "../Util/type";

export function isPUI(_pageInfo: PageInfo): boolean {
  return false;
}

export function isPUIOnPage(_pageInfo: any, _x: number, _y: number): boolean {
  return false;
}

export default class PUIController {
  static getInstance(): PUIController {
    return new PUIController();
  }
  async getPuiCommand(_pageInfo: any, _x: number, _y: number): Promise<string | null> {
    return null;
  }
}
