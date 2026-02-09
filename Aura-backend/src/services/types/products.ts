// src/types/products.ts
export type Warehouse = {
  code: string;
  name: string;
  stock: number;
  isExternal?: boolean;
};

export type Product = {
  ref: string;
  commercialRef?: string;
  name: string;

  brandCode?: string;
  brandName?: string;

  isAvailable?: boolean;

  price?: number;
  taxes?: number;
  discount?: number;
  vat?: number;
  turnover?: number;

  warehouses?: Warehouse[];
};
