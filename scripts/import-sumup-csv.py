#!/usr/bin/env python3
"""Convert a SumUp item CSV export to the public storefront JSON catalog."""

import argparse
import csv
import json
import math
import os
import re
import sys
import tempfile
from decimal import Decimal, InvalidOperation
from pathlib import Path


REQUIRED_HEADERS = (
    "Item name",
    "Variations",
    "Option set 1",
    "Option 1",
    "Option set 2",
    "Option 2",
    "Option set 3",
    "Option 3",
    "Option set 4",
    "Option 4",
    "Is variation visible? (Yes/No)",
    "Price",
    "Cost price",
    "Variable price? (Yes/No)",
    "Tax rate (%)",
    "On sale in Online Store?",
    "Regular price (before sale)",
    "Set up different prices and VAT for takeaway",
    "Takeaway price",
    "Takeaway tax rate",
    "Unit",
    "Track inventory? (Yes/No)",
    "Quantity",
    "Low stock threshold",
    "SKU",
    "Barcode",
    "Modifiers",
    "Description (Online Store and Invoices only)",
    "Category",
    "Display item at Checkout? (Yes/No)",
    "Display colour in POS checkout",
    "Image 1",
    "Image 2",
    "Image 3",
    "Image 4",
    "Image 5",
    "Image 6",
    "Display item in Online Store? (Yes/No)",
    "SEO title (Online Store only)",
    "SEO description (Online Store only)",
    "Shipping weight [kg] (Online Store only)",
    "Display service in Bookings? (Yes/No)",
    "Duration [minutes] (Bookings only)",
    "Location [business/customer] (Bookings only)",
    "Item id (Do not change)",
    "Variant id (Do not change)",
)

BOOLEAN_VALUES = {
    "yes": True,
    "y": True,
    "true": True,
    "1": True,
    "oui": True,
    "no": False,
    "n": False,
    "false": False,
    "0": False,
    "non": False,
}
WHITESPACE_RE = re.compile(r"[\s\u00a0\u202f]+")


class CatalogImportError(ValueError):
    """Raised when the CSV cannot safely replace the storefront catalog."""


def clean_text(value):
    if value is None:
        return ""
    return value.strip()


def nullable_text(value):
    value = clean_text(value)
    return value or None


def parse_boolean(value, field, row_number):
    text = clean_text(value).casefold()
    if not text:
        return None
    if text not in BOOLEAN_VALUES:
        raise CatalogImportError(f"ligne {row_number}: valeur invalide pour « {field} »")
    return BOOLEAN_VALUES[text]


def parse_decimal(value, field, row_number):
    text = clean_text(value)
    if not text:
        return None

    text = WHITESPACE_RE.sub("", text).replace("€", "").replace("EUR", "").replace("eur", "")
    text = text.replace("'", "").replace("’", "")
    if "," in text and "." in text:
        decimal_separator = "," if text.rfind(",") > text.rfind(".") else "."
        thousands_separator = "." if decimal_separator == "," else ","
        text = text.replace(thousands_separator, "")
        if decimal_separator == ",":
            text = text.replace(",", ".")
    elif "," in text:
        text = text.replace(",", ".")

    try:
        number = Decimal(text)
    except InvalidOperation as error:
        raise CatalogImportError(f"ligne {row_number}: nombre invalide pour « {field} »") from error
    if not number.is_finite() or number < 0:
        raise CatalogImportError(f"ligne {row_number}: nombre invalide pour « {field} »")
    return number


def json_number(value):
    if value is None:
        return None
    result = float(value)
    if not math.isfinite(result):
        raise CatalogImportError("nombre hors limites")
    return result


def parse_quantity(value, row_number):
    number = parse_decimal(value, "Quantity", row_number)
    if number is None:
        return None
    if number != number.to_integral_value():
        raise CatalogImportError(f"ligne {row_number}: quantité non entière")
    return int(number)


def detect_dialect(csv_file):
    sample = csv_file.read(8192)
    csv_file.seek(0)
    try:
        return csv.Sniffer().sniff(sample, delimiters=",;\t")
    except csv.Error:
        return csv.excel


def read_catalog(csv_path):
    try:
        csv_file = csv_path.open("r", encoding="utf-8-sig", newline="")
    except OSError as error:
        raise CatalogImportError("impossible de lire le fichier CSV source") from error

    with csv_file:
        dialect = detect_dialect(csv_file)
        reader = csv.DictReader(csv_file, dialect=dialect)
        headers = reader.fieldnames
        if not headers:
            raise CatalogImportError("le CSV ne contient pas d’en-têtes")
        if len(headers) != len(set(headers)):
            raise CatalogImportError("le CSV contient des en-têtes en double")

        missing_headers = [header for header in REQUIRED_HEADERS if header not in headers]
        if missing_headers:
            raise CatalogImportError(
                "en-têtes SumUp manquants: " + ", ".join(missing_headers)
            )

        products = []
        seen_variant_ids = set()
        for row_number, row in enumerate(reader, start=2):
            if row is None:
                continue
            if None in row:
                raise CatalogImportError(f"ligne {row_number}: colonnes supplémentaires inattendues")
            if all(not clean_text(value) for value in row.values() if value is not None):
                continue
            if any(value is None for value in row.values()):
                raise CatalogImportError(f"ligne {row_number}: nombre de colonnes incomplet")

            name = clean_text(row["Item name"])
            item_id = clean_text(row["Item id (Do not change)"])
            if not name:
                raise CatalogImportError(f"ligne {row_number}: nom d’article manquant")
            if not item_id:
                raise CatalogImportError(f"ligne {row_number}: identifiant d’article manquant")

            variant_id = nullable_text(row["Variant id (Do not change)"])
            if variant_id and variant_id in seen_variant_ids:
                raise CatalogImportError(f"ligne {row_number}: identifiant de variante en double")
            if variant_id:
                seen_variant_ids.add(variant_id)

            online_visible = parse_boolean(
                row["Display item in Online Store? (Yes/No)"],
                "Display item in Online Store? (Yes/No)",
                row_number,
            )
            variation_visible = parse_boolean(
                row["Is variation visible? (Yes/No)"],
                "Is variation visible? (Yes/No)",
                row_number,
            )
            on_sale = parse_boolean(
                row["On sale in Online Store?"],
                "On sale in Online Store?",
                row_number,
            )
            track_inventory = parse_boolean(
                row["Track inventory? (Yes/No)"],
                "Track inventory? (Yes/No)",
                row_number,
            )

            images = [nullable_text(row[f"Image {number}"]) for number in range(1, 7)]
            options = [
                {
                    "set": nullable_text(row[f"Option set {number}"]),
                    "value": nullable_text(row[f"Option {number}"]),
                }
                for number in range(1, 5)
            ]

            products.append(
                {
                    "name": name,
                    "price": json_number(parse_decimal(row["Price"], "Price", row_number)),
                    "category": clean_text(row["Category"]),
                    "description": clean_text(
                        row["Description (Online Store and Invoices only)"]
                    ),
                    "image": next((image for image in images if image), ""),
                    "sku": nullable_text(row["SKU"]),
                    "trackInventory": track_inventory,
                    "quantity": parse_quantity(row["Quantity"], row_number),
                    "visibleOnline": online_visible is True and variation_visible is not False,
                    "sumupItemId": item_id,
                    "sumupVariantId": variant_id,
                    "images": images,
                    "variations": nullable_text(row["Variations"]),
                    "options": options,
                    "variationVisible": variation_visible,
                    "onlineStoreVisible": online_visible,
                    "isOnSale": on_sale,
                    "regularPrice": json_number(
                        parse_decimal(
                            row["Regular price (before sale)"],
                            "Regular price (before sale)",
                            row_number,
                        )
                    ),
                }
            )

    if not products:
        raise CatalogImportError("le CSV ne contient aucune ligne produit")
    if not any(product["visibleOnline"] for product in products):
        raise CatalogImportError("aucun produit visible en ligne; catalogue existant conservé")
    return products


def write_catalog(products, output_path):
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="\n",
            dir=output_path.parent,
            prefix=f".{output_path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary_file:
            temporary_path = Path(temporary_file.name)
            json.dump(products, temporary_file, ensure_ascii=False, indent=2)
            temporary_file.write("\n")

        parsed = json.loads(temporary_path.read_text(encoding="utf-8"))
        if not isinstance(parsed, list) or not parsed:
            raise CatalogImportError("le JSON généré est vide ou invalide")
        if len(parsed) != len(products) or not any(
            product["visibleOnline"] is True for product in parsed
        ):
            raise CatalogImportError("le JSON généré a échoué à la validation")
        os.replace(temporary_path, output_path)
    finally:
        if temporary_path and temporary_path.exists():
            temporary_path.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--csv", required=True, type=Path, help="fichier d’export SumUp")
    parser.add_argument(
        "--output",
        required=True,
        type=Path,
        help="chemin du JSON catalogue à générer",
    )
    args = parser.parse_args()

    try:
        products = read_catalog(args.csv)
        write_catalog(products, args.output)
    except (CatalogImportError, OSError, UnicodeError, csv.Error) as error:
        print(f"Import SumUp arrêté: {error}", file=sys.stderr)
        return 1

    visible_count = sum(product["visibleOnline"] for product in products)
    print(
        f"Catalogue validé: {len(products)} lignes, "
        f"{visible_count} visibles en ligne."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
