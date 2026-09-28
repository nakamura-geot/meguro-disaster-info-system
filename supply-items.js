// 救援物資の品目マスタ。サーバー（入力値の検証）とブラウザ（選択画面）で共有する。
// 要求・配送は箱単位で行うため、単位は「箱」とし、1箱の入数は品目名に含める。
// 入数の根拠: 粉ミルクは目黒区地域防災計画 資料編（1箱＝一般用16缶＋アレルギー用1缶）、
// 飲料水（500ml×24本＝12L）とアルファ米（1箱50食）は自治体の備蓄品一覧で一般的な入数。
// それ以外の入数は本システムの運用値なので、区の調達単位に合わせて要調整。
const SUPPLY_ITEMS = [
  { code: 'water', name: '飲料水 500ml（1箱24本入り）', unit: '箱', category: '飲料・食料', defaultQuantity: 20 },
  { code: 'food', name: 'アルファ米（1箱50食入り）', unit: '箱', category: '飲料・食料', defaultQuantity: 4 },
  { code: 'biscuit', name: 'ビスケット（1箱24食入り）', unit: '箱', category: '飲料・食料', defaultQuantity: 10 },
  { code: 'babyFormula', name: '粉ミルク（1箱17缶入り・うちアレルギー対応1缶）', unit: '箱', category: '飲料・食料', defaultQuantity: 1 },
  { code: 'babyFood', name: '離乳食（1箱24食入り）', unit: '箱', category: '飲料・食料', defaultQuantity: 2 },

  { code: 'blanket', name: '毛布（1箱10枚入り）', unit: '箱', category: '生活用品', defaultQuantity: 10 },
  { code: 'towel', name: 'タオル（1箱50枚入り）', unit: '箱', category: '生活用品', defaultQuantity: 2 },
  { code: 'blueSheet', name: 'ブルーシート（1箱10枚入り）', unit: '箱', category: '生活用品', defaultQuantity: 2 },
  { code: 'cardboardBed', name: '段ボールベッド', unit: '台', category: '生活用品', defaultQuantity: 20 },
  { code: 'partition', name: 'パーティション（テント）', unit: '台', category: '生活用品', defaultQuantity: 10 },

  { code: 'portableToiletBag', name: '携帯トイレ（1箱100回分入り）', unit: '箱', category: '衛生用品', defaultQuantity: 10 },
  { code: 'portableToilet', name: '簡易トイレ便座', unit: '台', category: '衛生用品', defaultQuantity: 5 },
  { code: 'diaperBaby', name: '紙おむつ 乳児用（1箱100枚入り）', unit: '箱', category: '衛生用品', defaultQuantity: 2 },
  { code: 'diaperAdult', name: '紙おむつ 大人用（1箱80枚入り）', unit: '箱', category: '衛生用品', defaultQuantity: 2 },
  { code: 'sanitaryGoods', name: '生理用品（1箱20パック入り）', unit: '箱', category: '衛生用品', defaultQuantity: 2 },
  { code: 'mask', name: 'マスク（1箱50枚入り）', unit: '箱', category: '衛生用品', defaultQuantity: 4 },
  { code: 'disinfectant', name: '消毒液（1箱12本入り）', unit: '箱', category: '衛生用品', defaultQuantity: 2 },

  { code: 'generator', name: '発電機（900W）', unit: '台', category: '資機材', defaultQuantity: 2 },
  { code: 'floodlight', name: '投光器', unit: '台', category: '資機材', defaultQuantity: 4 },
  { code: 'gasStove', name: 'カセットコンロ', unit: '台', category: '資機材', defaultQuantity: 10 },
];

const SUPPLY_ITEMS_BY_CODE = new Map(SUPPLY_ITEMS.map((item) => [item.code, item]));

const REQUEST_STATUS = { requested: '要求中', arranged: '手配済', delivered: '配送完了' };

module.exports = { SUPPLY_ITEMS, SUPPLY_ITEMS_BY_CODE, REQUEST_STATUS };
