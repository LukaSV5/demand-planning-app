"""
Demand Planning — Synthetic Data Generator
Run this in Jupyter or as a plain Python script.
Outputs 4 CSV files into the same folder as this script.
"""

import pandas as pd
import numpy as np
from datetime import datetime, timedelta
import random, os

np.random.seed(42)
random.seed(42)

OUT_DIR = os.path.dirname(os.path.abspath(__file__))

# ─────────────────────────────────────────────────────────────
# 1. PRODUCT CATALOGUE  (150 SKUs across 7 categories)
# ─────────────────────────────────────────────────────────────

CATALOGUE = {
    'Electronics': [
        'Wireless Earbuds','Smart Speaker','USB-C Hub','Portable Charger',
        'LED Desk Lamp','Mechanical Keyboard','Gaming Mouse','Webcam HD',
        'HDMI Cable 2m','Screen Protector','Phone Stand','Cable Organiser',
        'Bluetooth Adapter','Smart Plug','Power Strip 4-Port','Monitor Arm',
        'SD Card 128GB','Laptop Stand','Ring Light 10in','Surge Protector',
    ],
    'Home & Kitchen': [
        'Coffee Maker','Blender Pro','Air Fryer 5L','Cutting Board Set',
        'Storage Container 3pk','Knife Set 5pc','Mixing Bowls 4pk','Salad Spinner',
        'Can Opener','Vegetable Peeler','Colander Stainless','Kitchen Scale',
        'Dish Rack Foldable','Oven Mitts Pair','Spice Rack 12-Jar','Fruit Bowl',
        'French Press 1L','Toaster 2-Slice','Electric Kettle','Bread Box',
    ],
    'Office Supplies': [
        'Sticky Notes 12pk','Ballpoint Pens 20pk','Desk Organiser','A4 Notebook',
        'Stapler Heavy Duty','Paper Clips 200pk','Ruler 30cm','Highlighter 8pk',
        'Correction Tape','Binder Clips 50pk','Folder Set A4','Index Cards 200pk',
        'Whiteboard Markers','Laminator Pouches','Desk Pad','Document Tray',
        'Tape Dispenser','Scissors Pro','Rubber Bands 200g','Pencil Case',
    ],
    'Fitness': [
        'Resistance Bands Set','Foam Roller 60cm','Yoga Mat 6mm','Jump Rope Speed',
        'Dumbbell 5kg Pair','Pull-Up Bar Doorway','Ab Wheel Roller','Water Bottle 1L',
        'Gym Gloves','Knee Support Pair','Protein Shaker 750ml','Exercise Ball 65cm',
        'Skipping Rope','Balance Board','Push-Up Bars','Ankle Weights 2kg',
        'Massage Gun','Gym Bag','Resistance Loop Bands','Fitness Tracker Band',
    ],
    'Beauty & Health': [
        'Face Moisturiser 50ml','Sunscreen SPF50 200ml','Vitamin C Serum 30ml',
        'Shampoo 500ml','Conditioner 500ml','Body Lotion 400ml',
        'Toothbrush Electric','Floss Picks 100pk','Hand Sanitiser 500ml',
        'Eye Cream 15ml','Lip Balm 3pk','Hair Mask 300ml',
        'Face Mask 10pk','Essential Oil Set','Nail File 10pk','Cotton Pads 100pk',
        'Micellar Water 400ml','Toner 200ml','BB Cream SPF30','Eyebrow Pencil',
    ],
    'Toys & Games': [
        'Building Blocks 500pc','Puzzle 1000pc','Card Game Family','Board Game Classic',
        'Colouring Book 100pg','Toy Car Set 6pk','Action Figure 30cm','Stuffed Bear 40cm',
        'RC Car Off-Road','Science Experiment Kit','Art Supply Set','Magnetic Tiles 32pk',
        'Water Pistol Super','Frisbee Pro','Play-Doh 6pk','Bubble Machine',
        'Skipping Rope Kids','Kite Starter','Marble Run 100pc','Mini Drone',
    ],
    'Garden': [
        'Potting Mix 10L','Garden Gloves M','Plant Pot 20cm','Watering Can 8L',
        'Pruning Shears','Garden Fork Steel','Seed Starter Kit 72-Cell','Plant Food 1L',
        'Hanging Basket 35cm','Garden Hose 15m','Kneeling Pad','Trowel Set 3pk',
        'Bird Feeder Wooden','Compost Bin 220L','Lawn Spreader','Pest Control Spray',
        'Raised Bed Kit','Solar Garden Lights 4pk','Leaf Blower Cordless','Weed Killer 1L',
    ],
}

skus = []
counter = 1000
for cat, products in CATALOGUE.items():
    for prod in products:
        unit_price = round(random.uniform(4.99, 94.99), 2)
        skus.append({
            'SKU':         f'SKU-{counter:04d}',
            'Description': prod,
            'Category':    cat,
            'UnitPrice':   unit_price,
            'CostPrice':   round(unit_price * random.uniform(0.38, 0.62), 2),
        })
        counter += 1

sku_df = pd.DataFrame(skus)
print(f"✔ Product catalogue: {len(sku_df)} SKUs")

# ─────────────────────────────────────────────────────────────
# 2. SEASONAL DEMAND MODEL
# ─────────────────────────────────────────────────────────────

SEASONAL_BASE = {
    1:0.75, 2:0.70, 3:0.85, 4:0.90, 5:0.95, 6:1.00,
    7:1.05, 8:1.00, 9:0.95, 10:1.10, 11:1.40, 12:1.65,
}
CAT_OVERRIDES = {
    'Fitness':         {1:1.50, 2:1.30, 9:1.20},
    'Garden':          {3:1.30, 4:1.60, 5:1.70, 6:1.40},
    'Toys & Games':    {11:1.70, 12:2.10},
    'Electronics':     {11:1.55, 12:1.85},
    'Beauty & Health': {6:1.25, 7:1.25, 12:1.30},
}

def seasonal_mult(month, category):
    m = SEASONAL_BASE.get(month, 1.0)
    if category in CAT_OVERRIDES and month in CAT_OVERRIDES[category]:
        m *= CAT_OVERRIDES[category][month]
    return m

# Base monthly demand per SKU
base_demand = {s['SKU']: random.randint(40, 500) for s in skus}

# ─────────────────────────────────────────────────────────────
# 3. SALES HISTORY  (~80 000 rows, Jan 2022 – Dec 2024)
# ─────────────────────────────────────────────────────────────

START = datetime(2022, 1, 1)
END   = datetime(2024, 12, 31)
COUNTRIES = [
    'United Kingdom','Germany','France','Spain','Netherlands',
    'Australia','United States','Belgium','Ireland','Sweden',
]
CHANNELS = ['Website', 'Marketplace', 'Wholesale', 'Retail', 'B2B']

print("Generating sales history — this may take 20–40 seconds...")

records = []
invoice_no = 500000
sku_lookup = {s['SKU']: s for s in skus}
d = START

while d <= END:
    n_orders = random.randint(20, 60)
    day_skus = random.choices(skus, k=n_orders)

    months_elapsed = (d.year - 2022) * 12 + d.month
    trend = 1 + 0.007 * months_elapsed          # ~8% YoY growth

    for row in day_skus:
        sf  = seasonal_mult(d.month, row['Category'])
        avg = base_demand[row['SKU']] / 30
        qty = max(1, int(avg * sf * trend * random.uniform(0.4, 2.8)))

        n_lines = random.randint(1, 4)
        for _ in range(n_lines):
            line_qty = max(1, int(qty * random.uniform(0.5, 1.8)))
            records.append({
                'InvoiceNo':   invoice_no,
                'StockCode':   row['SKU'],
                'Description': row['Description'],
                'Quantity':    line_qty,
                'InvoiceDate': d.strftime('%Y-%m-%d'),
                'UnitPrice':   row['UnitPrice'],
                'Revenue':     round(line_qty * row['UnitPrice'], 2),
                'CustomerID':  f'CUST-{random.randint(10000, 99999)}',
                'Country':     random.choice(COUNTRIES),
                'Channel':     random.choice(CHANNELS),
                'Category':    row['Category'],
            })
        invoice_no += 1

    d += timedelta(days=1)

sales_df = pd.DataFrame(records)
path = os.path.join(OUT_DIR, 'sales_history.csv')
sales_df.to_csv(path, index=False)
print(f"✔ sales_history.csv  →  {len(sales_df):,} rows  ({path})")

# ─────────────────────────────────────────────────────────────
# 4. STOCK LEVELS  (1 row per SKU)
# ─────────────────────────────────────────────────────────────

WAREHOUSES = ['Warehouse A', 'Warehouse B', 'Warehouse C']
AISLES     = ['A','B','C','D','E']

stock_rows = []
for s in skus:
    monthly = base_demand[s['SKU']]
    safety  = int(monthly * random.uniform(0.25, 0.75))
    stock   = int(monthly * random.uniform(0.05, 3.2))
    reserved = int(stock * random.uniform(0.0, 0.18))
    available = max(0, stock - reserved)

    stock_rows.append({
        'SKU':          s['SKU'],
        'Description':  s['Description'],
        'Category':     s['Category'],
        'Stock':        stock,
        'OnHand':       stock,
        'Available':    available,
        'Reserved':     reserved,
        'SafetyStock':  safety,
        'ReorderPoint': safety + int(monthly * 0.4),
        'Warehouse':    random.choice(WAREHOUSES),
        'Location':     f'{random.choice(AISLES)}{random.randint(1,25)}-{random.randint(1,6)}',
        'LastUpdated':  '2024-12-31',
    })

stock_df = pd.DataFrame(stock_rows)
path = os.path.join(OUT_DIR, 'stock_levels.csv')
stock_df.to_csv(path, index=False)
print(f"✔ stock_levels.csv   →  {len(stock_df):,} rows  ({path})")

# ─────────────────────────────────────────────────────────────
# 5. SUPPLIERS & LEAD TIMES  (1 row per SKU)
# ─────────────────────────────────────────────────────────────

SUPPLIERS = [
    'Apex Global Ltd','Sunrise Trading Co','Pacific Imports BV',
    'Euro Wholesale GmbH','Meridian Supply Group','FastShip Direct',
    'Zhen Yue Manufacturing','Nordic Goods AS','Atlas Distributors',
    'Prime Source UK','Horizon Trade Ltd','Coastal Imports Co',
]
ORIGINS  = ['China','Germany','United Kingdom','Netherlands','Taiwan','Vietnam','India','Poland','Turkey','Bangladesh']
PAY_TERMS = ['Net 30','Net 60','Net 45','2/10 Net 30','Prepaid','Net 90']
CURRENCIES = ['GBP','EUR','USD']
LEAD_OPTS  = [7, 10, 14, 21, 28, 35, 45, 60]
MOQ_OPTS   = [10, 20, 25, 50, 100, 150, 200, 250, 500]

sup_rows = []
for s in skus:
    sup_rows.append({
        'SKU':             s['SKU'],
        'Description':     s['Description'],
        'Supplier':        random.choice(SUPPLIERS),
        'Vendor':          random.choice(SUPPLIERS),
        'LeadTime':        random.choice(LEAD_OPTS),
        'MOQ':             random.choice(MOQ_OPTS),
        'MinimumOrder':    random.choice(MOQ_OPTS),
        'PurchasePrice':   s['CostPrice'],
        'CostPrice':       s['CostPrice'],
        'PaymentTerms':    random.choice(PAY_TERMS),
        'CountryOfOrigin': random.choice(ORIGINS),
        'Currency':        random.choice(CURRENCIES),
        'ActiveSupplier':  random.choice([True, True, True, False]),
    })

sup_df = pd.DataFrame(sup_rows)
path = os.path.join(OUT_DIR, 'suppliers.csv')
sup_df.to_csv(path, index=False)
print(f"✔ suppliers.csv      →  {len(sup_df):,} rows  ({path})")

# ─────────────────────────────────────────────────────────────
# 6. OPEN PURCHASE ORDERS  (40 open POs)
# ─────────────────────────────────────────────────────────────

TODAY    = datetime(2024, 12, 31)
PO_SKUS  = random.sample(skus, 40)
STATUSES = ['Confirmed', 'In Transit', 'Pending', 'Shipped', 'Awaiting Customs']
QTY_OPTS = [50, 100, 150, 200, 250, 300, 500, 750, 1000]

po_rows = []
for i, s in enumerate(PO_SKUS):
    lead = random.randint(7, 45)
    order_date    = TODAY - timedelta(days=random.randint(1, lead))
    delivery_date = TODAY + timedelta(days=random.randint(1, 35))
    status        = random.choice(STATUSES)
    in_transit    = status in ('In Transit', 'Shipped')
    ordered_qty   = random.choice(QTY_OPTS)

    po_rows.append({
        'PONumber':        f'PO-2024-{1000 + i}',
        'PurchaseOrder':   f'PO-2024-{1000 + i}',
        'SKU':             s['SKU'],
        'StockCode':       s['SKU'],
        'Description':     s['Description'],
        'Supplier':        random.choice(SUPPLIERS),
        'Vendor':          random.choice(SUPPLIERS),
        'OrderedQty':      ordered_qty,
        'OrderedQuantity': ordered_qty,
        'OrderDate':       order_date.strftime('%Y-%m-%d'),
        'ExpectedDelivery':delivery_date.strftime('%Y-%m-%d'),
        'DeliveryDate':    delivery_date.strftime('%Y-%m-%d'),
        'Status':          status,
        'InTransit':       in_transit,
        'Inbound':         True,
        'TotalValue':      round(ordered_qty * s['CostPrice'], 2),
        'Currency':        random.choice(CURRENCIES),
    })

po_df = pd.DataFrame(po_rows)
path = os.path.join(OUT_DIR, 'purchase_orders.csv')
po_df.to_csv(path, index=False)
print(f"✔ purchase_orders.csv →  {len(po_df):,} rows  ({path})")

# ─────────────────────────────────────────────────────────────
# SUMMARY
# ─────────────────────────────────────────────────────────────
print()
print("=" * 55)
print("  ALL FILES SAVED TO:", OUT_DIR)
print("=" * 55)
print(f"  sales_history.csv     {len(sales_df):>8,} rows")
print(f"  stock_levels.csv      {len(stock_df):>8,} rows")
print(f"  suppliers.csv         {len(sup_df):>8,} rows")
print(f"  purchase_orders.csv   {len(po_df):>8,} rows")
print("=" * 55)
print()
print("Upload all 4 files together in the dashboard Upload Data page.")
print("The system will detect all 4 categories automatically.")
