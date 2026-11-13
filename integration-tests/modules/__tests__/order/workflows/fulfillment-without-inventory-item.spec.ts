import {
  cancelOrderFulfillmentWorkflow,
  createOrderFulfillmentWorkflow,
  createOrderShipmentWorkflow,
  createShippingOptionsWorkflow,
  markOrderFulfillmentAsDeliveredWorkflow,
} from "@medusajs/core-flows"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils"

jest.setTimeout(500000)

const env = {}

const PROVIDER_ID = "manual_test-provider"

const address = {
  first_name: "Test",
  last_name: "Test",
  address_1: "Test",
  city: "Test",
  country_code: "us",
  postal_code: "12345",
}

/**
 * A variant linked to an inventory item, but with manage_inventory disabled,
 * and an order for it. Nothing is reserved, so its fulfillment items get no
 * inventory_item_id.
 */
async function seed(container) {
  const fulfillmentModule = container.resolve(Modules.FULFILLMENT)
  const salesChannelModule = container.resolve(Modules.SALES_CHANNEL)
  const stockLocationModule = container.resolve(Modules.STOCK_LOCATION)
  const productModule = container.resolve(Modules.PRODUCT)
  const inventoryModule = container.resolve(Modules.INVENTORY)
  const orderModule = container.resolve(Modules.ORDER)
  const link = container.resolve(ContainerRegistrationKeys.LINK)

  const shippingProfile = await fulfillmentModule.createShippingProfiles({
    name: "Default",
    type: "default",
  })
  const fulfillmentSet = await fulfillmentModule.createFulfillmentSets({
    name: "Warehouse delivery",
    type: "shipping",
  })
  const serviceZone = await fulfillmentModule.createServiceZones({
    name: "US",
    fulfillment_set_id: fulfillmentSet.id,
    geo_zones: [{ type: "country", country_code: "us" }],
  })
  const salesChannel = await salesChannelModule.createSalesChannels({
    name: "Webshop",
  })
  const location = await stockLocationModule.createStockLocations({
    name: "Warehouse",
    address: { address_1: "Test", city: "Test", country_code: "us" },
  })

  const [product] = await productModule.createProducts([
    {
      title: "Chair",
      variants: [{ title: "Default", sku: "CHAIR", manage_inventory: false }],
    },
  ])
  const variant = product.variants[0]

  const inventoryItem = await inventoryModule.createInventoryItems({
    sku: "CHAIR",
  })
  await inventoryModule.createInventoryLevels([
    {
      inventory_item_id: inventoryItem.id,
      location_id: location.id,
      stocked_quantity: 10,
    },
  ])

  await link.create([
    {
      [Modules.STOCK_LOCATION]: { stock_location_id: location.id },
      [Modules.FULFILLMENT]: { fulfillment_provider_id: PROVIDER_ID },
    },
    {
      [Modules.STOCK_LOCATION]: { stock_location_id: location.id },
      [Modules.FULFILLMENT]: { fulfillment_set_id: fulfillmentSet.id },
    },
    {
      [Modules.SALES_CHANNEL]: { sales_channel_id: salesChannel.id },
      [Modules.STOCK_LOCATION]: { stock_location_id: location.id },
    },
    {
      [Modules.PRODUCT]: { product_id: product.id },
      [Modules.FULFILLMENT]: { shipping_profile_id: shippingProfile.id },
    },
    {
      [Modules.PRODUCT]: { variant_id: variant.id },
      [Modules.INVENTORY]: { inventory_item_id: inventoryItem.id },
    },
  ])

  const {
    result: [shippingOption],
  } = await createShippingOptionsWorkflow(container).run({
    input: [
      {
        name: "Standard",
        price_type: "flat",
        service_zone_id: serviceZone.id,
        shipping_profile_id: shippingProfile.id,
        provider_id: PROVIDER_ID,
        type: { code: "standard", label: "Standard", description: "Standard" },
        prices: [{ currency_code: "usd", amount: 10 }],
      },
    ],
  })

  const order = await orderModule.createOrders({
    email: "customer@example.com",
    currency_code: "usd",
    sales_channel_id: salesChannel.id,
    shipping_address: address,
    billing_address: address,
    items: [
      {
        title: "Chair",
        product_id: product.id,
        variant_id: variant.id,
        variant_sku: "CHAIR",
        variant_title: "Default",
        quantity: 1,
        unit_price: 50,
      },
    ],
    shipping_methods: [
      { name: "Standard", amount: 10, shipping_option_id: shippingOption.id },
    ],
  })

  return { order, variant, location }
}

/**
 * Fulfills the order while the variant doesn't manage inventory, then turns
 * manage_inventory on, as when a store starts tracking stock after launch.
 */
async function fulfillThenManageInventory(container) {
  const { order, variant, location } = await seed(container)

  const { result: fulfillment } = await createOrderFulfillmentWorkflow(
    container
  ).run({
    input: {
      order_id: order.id,
      location_id: location.id,
      items: [{ id: order.items![0].id, quantity: 1 }],
    },
  })

  await container
    .resolve(Modules.PRODUCT)
    .updateProductVariants(variant.id, { manage_inventory: true })

  return { order, fulfillment }
}

medusaIntegrationTestRunner({
  env,
  testSuite: ({ getContainer }) => {
    describe("Fulfillment items without inventory_item_id", () => {
      it("are created when the variant doesn't manage inventory", async () => {
        const { fulfillment } = await fulfillThenManageInventory(getContainer())

        expect(fulfillment.items).toHaveLength(1)
        expect(fulfillment.items[0].inventory_item_id).toBeNull()
      })

      it("can be marked as delivered", async () => {
        const container = getContainer()
        const { order, fulfillment } =
          await fulfillThenManageInventory(container)

        await markOrderFulfillmentAsDeliveredWorkflow(container).run({
          input: { orderId: order.id, fulfillmentId: fulfillment.id },
        })
      })

      it("can be shipped", async () => {
        const container = getContainer()
        const { order, fulfillment } =
          await fulfillThenManageInventory(container)

        await createOrderShipmentWorkflow(container).run({
          input: {
            order_id: order.id,
            fulfillment_id: fulfillment.id,
            items: [{ id: order.items![0].id, quantity: 1 }],
          },
        })
      })

      it("can be canceled", async () => {
        const container = getContainer()
        const { order, fulfillment } =
          await fulfillThenManageInventory(container)

        await cancelOrderFulfillmentWorkflow(container).run({
          input: { order_id: order.id, fulfillment_id: fulfillment.id },
        })
      })
    })
  },
})
